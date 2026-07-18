# Channels

See the [7 Channels reference](../reference/channels.md) for the full API.

## Why Channels?

The same agent instance — same tools, same memory, same skills — can be exposed through 7 different surfaces. This is what "compose" means in practice: write your business logic once, deliver it wherever your users are.

## Channel Lifecycle

Every channel implements:

```ts
interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<OutgoingMessage>): void;
}
```

The `start()` method typically kicks off an HTTP server or a long-poll loop and blocks until `stop()` is called.
