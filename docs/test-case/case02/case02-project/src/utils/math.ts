// 故意植入的缺陷：
// 1. divide 函数返回类型标注为 number，但可能返回 string
// 2. unusedVar 未被使用（触发 noUnusedLocals）

export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    return "Error: Division by zero";  // 类型错误：string 赋给 number
  }
  return a / b;
}

export function multiply(a: number, b: number): number {
  const unusedVar = 42;  // 未使用变量
  return a * b;
}
