# Buggy FizzBuzz — logic error
def fizzbuzz(n):
    result = []
    for i in range(1, n + 1):
        if i % 3 == 0:              # BUG: should check % 15 first
            result.append("Fizz")
        elif i % 5 == 0:
            result.append("Buzz")
        elif i % 15 == 0:           # This branch is unreachable
            result.append("FizzBuzz")
        else:
            result.append(str(i))
    return result


if __name__ == "__main__":
    out = fizzbuzz(15)
    expected = ["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"]
    if out == expected:
        print("ALL TESTS PASSED")
    else:
        print("FAILED")
        print("Got:", out)
        print("Exp:", expected)
