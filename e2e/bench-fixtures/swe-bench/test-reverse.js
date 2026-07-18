// Test file for reverse.js — DO NOT MODIFY
const { reverseString } = require('./reverse');

const tests = [
  { input: "hello", expected: "olleh" },
  { input: "", expected: "" },
  { input: "a", expected: "a" },
  { input: "ab", expected: "ba" },
  { input: "racecar", expected: "racecar" },
  { input: "JavaScript", expected: "tpircSavaJ" },
];

let passed = 0, failed = 0;
for (const t of tests) {
  const result = reverseString(t.input);
  if (result === t.expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: reverseString("${t.input}") = "${result}", expected "${t.expected}"`);
  }
}
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(failed === 0 ? 0 : 1);
