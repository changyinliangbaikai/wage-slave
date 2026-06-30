// 故意植入的缺陷：
// 1. 导入了 UsedInterface 但未使用（触发 noUnusedLocals）
// 2. 调用了不存在的函数 nonExistentFunction

import { add, divide } from "./utils/math";
import { reverse } from "./utils/string";
import { UsedInterface } from "./types";

export function main(): void {
  const sum = add(1, 2);
  console.log("Sum:", sum);

  const result = divide(10, 0);
  console.log("Result:", result);

  const reversed = reverse("hello");
  console.log("Reversed:", reversed);

  nonExistentFunction();  // 调用不存在的函数
}

main();
