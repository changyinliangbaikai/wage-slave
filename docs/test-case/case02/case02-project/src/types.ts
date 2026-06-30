// 故意植入的缺陷：
// 1. UnusedInterface 从未被引用（触发 noUnusedLocals）

export interface UsedInterface {
  id: string;
  name: string;
}

interface UnusedInterface {
  data: any;
  callback: Function;
}
