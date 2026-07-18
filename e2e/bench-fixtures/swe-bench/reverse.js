// Buggy reverseString — fails on empty string and single char
function reverseString(s) {
  let result = "";
  for (let i = s.length - 1; i > 0; i--) {  // BUG: should be i >= 0
    result += s[i];
  }
  return result;
}

module.exports = { reverseString };
