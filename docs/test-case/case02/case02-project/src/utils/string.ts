// 故意植入的缺陷：
// 1. parseNumber 没有错误处理，传入非数字字符串会返回 NaN 但无提示

export function reverse(str: string): string {
  return str.split("").reverse().join("");
}

export function parseNumber(str: string): number {
  return parseInt(str, 10);
}
