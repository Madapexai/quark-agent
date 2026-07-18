// Buggy code: sum function has off-by-one error
function sum(arr) {
  let total = 0;
  for (let i = 0; i < arr.length - 1; i++) {  // BUG: should be i < arr.length
    total += arr[i];
  }
  return total;
}

module.exports = { sum };
