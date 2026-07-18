// Test file for sum.js — DO NOT MODIFY
const { sum } = require('./sum');

const tests = [
  { input: [1, 2, 3, 4, 5], expected: 15 },
  { input: [10], expected: 10 },
  { input: [], expected: 0 },
  { input: [1, 1, 1, 1], expected: 4 },
  { input: [-1, -2, -3], expected: -6 },
  { input: [100, 200, 300], expected: 600 },
];

let passed = 0, failed = 0;
for (const t of tests) {
  const result = sum(t.input);
  if (result === t.expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: sum(${JSON.stringify(t.input)}) = ${result}, expected ${t.expected}`);
  }
}
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(failed === 0 ? 0 : 1);
