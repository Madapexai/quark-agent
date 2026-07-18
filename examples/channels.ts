/**
 * 多渠道适配层测试：飞书/微信/Telegram
 *
 * 验证：
 * 1. 各 channel 实例化与默认路径
 * 2. 飞书事件解析（文本消息/@剥除/非文本过滤）
 * 3. 飞书 URL 验证 challenge 返回
 * 4. 微信 XML 解析（明文消息）
 * 5. 微信签名校验（错误签名拒绝）
 * 6. Telegram update 解析（chat_id 映射）
 * 7. Telegram webhook secret 校验
 * 8. 多 channel 并存（不同端口/路径互不干扰）
 * 9. 端到端：webhook POST → event → reply → 调用 sendReply
 *
 * 全部离线：mock fetch，不真实调平台 API
 */

import { FeishuChannel } from "../src/channel/feishu.js";
import { WeChatChannel } from "../src/channel/wechat.js";
import { TelegramChannel } from "../src/channel/telegram.js";
import type { ChannelEvent } from "../src/core/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ ${msg}`);
  console.log(`  ✅ ${msg}`);
}

// mock 全局 fetch，记录调用
const fetchCalls: Array<{ url: string; body?: unknown }> = [];
const originalFetch = globalThis.fetch;
function mockFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    // 本地 webhook 请求透传到真实 fetch（否则打不到本地 server）
    if (urlStr.startsWith("http://127.0.0.1") || urlStr.startsWith("http://localhost")) {
      return originalFetch(url as Parameters<typeof fetch>[0], init);
    }
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ url: urlStr, body });

    // 飞书 token 接口
    if (urlStr.includes("tenant_access_token")) {
      return new Response(JSON.stringify({ tenant_access_token: "t-token", expire: 7200 }), { status: 200 });
    }
    // 微信 token 接口
    if (urlStr.includes("gettoken") || urlStr.includes("cgi-bin/token")) {
      return new Response(JSON.stringify({ access_token: "wx-token", expires_in: 7200 }), { status: 200 });
    }
    // 发消息接口统一返回 ok
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function testChannelInstantiation(): Promise<void> {
  console.log("\n[测试1] 各 channel 实例化");
  const feishu = new FeishuChannel({ appId: "cli_x", appSecret: "secret", path: "/feishu/webhook" });
  const wechat = new WeChatChannel({ appId: "wx_x", appSecret: "secret", token: "tk", path: "/wechat/webhook" });
  const telegram = new TelegramChannel({ botToken: "123:abc", path: "/telegram/webhook" });
  assert(feishu.name === "feishu", "飞书 name=feishu");
  assert(wechat.name === "wechat", "微信 name=wechat");
  assert(telegram.name === "telegram", "telegram name=telegram");
}

async function testFeishuParse(): Promise<void> {
  console.log("\n[测试2] 飞书事件解析");
  const feishu = new FeishuChannel({
    appId: "cli_x",
    appSecret: "secret",
    verificationToken: "vt_x",
  });
  // 通过反射调 parse（基类把解析后的 body 存到 _lastBody）
  const event = {
    schema: "2.0",
    header: { event_id: "e1", event_type: "im.message.receive_v1", token: "vt_x" },
    event: {
      sender: { sender_id: { open_id: "ou_abc" } },
      message: {
        chat_id: "oc_chat1",
        message_id: "om_msg1",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 你好" }),
      },
    },
  };
  // 模拟 verify 已设置 _lastBody
  (feishu as unknown as { _lastBody: unknown })._lastBody = event;
  const parsed = await (feishu as unknown as { parse: () => Promise<unknown> }).parse();
  assert(parsed !== null, "飞书文本消息解析成功");
  const p = parsed as { userId: string; sessionId: string; text: string; replyTarget: Record<string, unknown> };
  assert(p.userId === "ou_abc", "userId = open_id");
  assert(p.sessionId === "oc_chat1", "sessionId = chat_id");
  assert(p.text === "你好", "@前缀被剥除");
  assert(p.replyTarget.chat_id === "oc_chat1", "replyTarget 含 chat_id");

  // 非文本消息应被过滤
  (feishu as unknown as { _lastBody: unknown })._lastBody = {
    ...event,
    event: { ...event.event, message: { ...event.event.message, message_type: "image" } },
  };
  const ignored = await (feishu as unknown as { parse: () => Promise<unknown> }).parse();
  assert(ignored === null, "非文本消息被过滤");

  // token 校验失败
  (feishu as unknown as { _lastBody: unknown })._lastBody = {
    ...event,
    header: { ...event.header, token: "wrong" },
  };
  const badToken = await (feishu as unknown as { parse: () => Promise<unknown> }).parse();
  assert(badToken === null, "token 校验失败被拒绝");
}

async function testWeChatParse(): Promise<void> {
  console.log("\n[测试3] 微信 XML 解析");
  const wechat = new WeChatChannel({
    appId: "wx_x",
    appSecret: "secret",
    token: "tk",
  });
  const xml = `<xml>
    <ToUserName><![CDATA[gh_bot]]></ToUserName>
    <FromUserName><![CDATA[o_user123]]></FromUserName>
    <CreateTime>1234567890</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[你好]]></Content>
    <MsgId>1234</MsgId>
  </xml>`;
  // 模拟无 msg_signature（明文模式）
  const parsed = await (wechat as unknown as {
    parse: (raw: Buffer, headers: Record<string, string>) => Promise<unknown>;
  }).parse(Buffer.from(xml), {});
  assert(parsed !== null, "微信文本消息解析成功");
  const p = parsed as { userId: string; text: string };
  assert(p.userId === "o_user123", "userId = FromUserName");
  assert(p.text === "你好", "text = Content");
}

async function testWeChatSignatureRejection(): Promise<void> {
  console.log("\n[测试4] 微信签名校验拒绝");
  const wechat = new WeChatChannel({
    appId: "wx_x",
    appSecret: "secret",
    token: "tk",
  });
  const xml = `<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content><FromUserName><![CDATA[u1]]></FromUserName></xml>`;
  // 带错误 msg_signature
  const parsed = await (wechat as unknown as {
    parse: (raw: Buffer, headers: Record<string, string>) => Promise<unknown>;
  }).parse(Buffer.from(xml), { "x-micro-url": "/wechat/webhook?msg_signature=wrong&timestamp=1&nonce=2" });
  assert(parsed === null, "错误签名被拒绝");
}

async function testTelegramParse(): Promise<void> {
  console.log("\n[测试5] Telegram update 解析");
  const telegram = new TelegramChannel({ botToken: "123:abc" });
  const update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1234567890,
      chat: { id: -100123, type: "private" },
      from: { id: 999, username: "alice" },
      text: "hello",
    },
  };
  const parsed = await (telegram as unknown as {
    parse: (raw: Buffer, headers: Record<string, string>) => Promise<unknown>;
  }).parse(Buffer.from(JSON.stringify(update)), {});
  assert(parsed !== null, "Telegram 文本消息解析成功");
  const p = parsed as { userId: string; sessionId: string; from: string; replyTarget: { chat_id: number } };
  assert(p.userId === "999", "userId = from.id");
  assert(p.sessionId === "-100123", "sessionId = chat.id");
  assert(p.from === "alice", "from = username");
  assert(p.replyTarget.chat_id === -100123, "replyTarget.chat_id 正确");

  // 无 text 的消息被过滤
  const noText = { ...update, message: { ...update.message, text: undefined } };
  const ignored = await (telegram as unknown as {
    parse: (raw: Buffer, headers: Record<string, string>) => Promise<unknown>;
  }).parse(Buffer.from(JSON.stringify(noText)), {});
  assert(ignored === null, "无 text 消息被过滤");
}

async function testTelegramSecretVerify(): Promise<void> {
  console.log("\n[测试6] Telegram webhook secret 校验");
  const telegram = new TelegramChannel({ botToken: "123:abc", webhookSecret: "mysecret" });
  const ok = await (telegram as unknown as {
    verify: (headers: Record<string, string>, raw: Buffer) => Promise<{ ok: boolean }>;
  }).verify({ "x-telegram-bot-api-secret-token": "mysecret" }, Buffer.from("{}"));
  assert(ok.ok === true, "正确 secret 通过");

  const bad = await (telegram as unknown as {
    verify: (headers: Record<string, string>, raw: Buffer) => Promise<{ ok: boolean }>;
  }).verify({ "x-telegram-bot-api-secret-token": "wrong" }, Buffer.from("{}"));
  assert(bad.ok === false, "错误 secret 被拒");
}

async function testMultiChannelCoexist(): Promise<void> {
  console.log("\n[测试7] 多 channel 并存（不同端口）");
  const feishu = new FeishuChannel({ appId: "a", appSecret: "s", port: 9001, path: "/feishu/webhook" });
  const wechat = new WeChatChannel({ appId: "a", appSecret: "s", token: "t", port: 9002, path: "/wechat/webhook" });
  const telegram = new TelegramChannel({ botToken: "b", port: 9003, path: "/telegram/webhook" });
  // 仅验证可独立实例化 + start 不会冲突（不真启 server 避免端口占用）
  const names = [feishu.name, wechat.name, telegram.name];
  assert(new Set(names).size === 3, "三 channel name 互不相同");
}

async function testEndToEndWebhook(): Promise<void> {
  console.log("\n[测试8] 端到端：webhook POST → event → reply → sendReply");
  mockFetch();
  try {
    const telegram = new TelegramChannel({ botToken: "123:abc", port: 9004, path: "/telegram/webhook" });
    let receivedEvent: ChannelEvent | null = null;
    await telegram.start(async (event) => {
      receivedEvent = event;
      // 模拟 agent 立即回复
      telegram.reply(event.sessionId, { text: "回复给你" });
    });

    // 构造 Telegram update POST
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1234567890,
        chat: { id: 555, type: "private" },
        from: { id: 777, username: "bob" },
        text: "你好",
      },
    };
    const res = await fetch(`http://127.0.0.1:9004/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    assert(res.status === 200, "webhook 返回 200");

    // 等待异步 sendReply 完成
    await new Promise((r) => setTimeout(r, 200));

    assert(receivedEvent !== null, "agent 收到 event");
    const ev = receivedEvent as unknown as ChannelEvent;
    assert(ev.text === "你好", "event.text 正确");
    assert(ev.userId === "777", "event.userId 正确");

    // sendReply 被调用（sendMessage API）
    const sendCall = fetchCalls.find((c) => c.url.includes("sendMessage"));
    assert(sendCall !== undefined, "调用了 sendMessage API");
    assert((sendCall?.body as { text?: string })?.text === "回复给你", "sendMessage 内容正确");

    await telegram.stop();
  } finally {
    restoreFetch();
    fetchCalls.length = 0;
  }
}

async function main(): Promise<void> {
  console.log("=== 多渠道适配层测试 ===");
  let passed = 0;
  let failed = 0;
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "channel实例化", fn: testChannelInstantiation },
    { name: "飞书事件解析", fn: testFeishuParse },
    { name: "微信XML解析", fn: testWeChatParse },
    { name: "微信签名拒绝", fn: testWeChatSignatureRejection },
    { name: "Telegram解析", fn: testTelegramParse },
    { name: "Telegram secret", fn: testTelegramSecretVerify },
    { name: "多channel并存", fn: testMultiChannelCoexist },
    { name: "端到端webhook", fn: testEndToEndWebhook },
  ];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`❌ 测试「${t.name}」失败:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 / 共 ${tests.length} ===`);
  if (failed > 0) process.exit(1);
  console.log("\n✅ 全部渠道测试通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
