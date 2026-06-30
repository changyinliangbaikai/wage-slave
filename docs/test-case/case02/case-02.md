# 测试用例02：自动化代码审查与修复验证

## 测试目标

验证小牛马 Agent 能否自主完成一个完整的工程化代码审查流程：**探索项目 → 发现问题 → 规划修复 → 逐项修复 → 验证结果 → 生成报告**。

考察核心能力：
- 多工具协同（`list_files` / `read_file` / `search_files` / `run_command` / `edit_file` / `write_file` / `save_todo` / `update_todo` / `append_log`）
- 自主规划与任务拆解能力
- 错误诊断与自我纠错（修复后重新验证）
- 工程化输出（结构化报告）

---

## 前置准备

### 1. 测试项目

测试项目已生成在 `docs/test-case/case02/case02-project/` 目录下，包含**故意植入的 5 类缺陷**。

目录结构：

```
docs/test-case/case02/case02-project/
├── src/
│   ├── utils/
│   │   ├── math.ts        # 含类型错误 + 未使用变量
│   │   └── string.ts      # 缺少错误处理（parseInt 未 try-catch）
│   ├── types.ts           # 含未使用的接口定义
│   └── index.ts           # 含未使用导入 + 调用不存在的函数
├── package.json            # 缺少 scripts 中的 typecheck 命令
└── tsconfig.json           # strict 模式
```

### 2. 各文件初始内容

#### `package.json`

```json
{
  "name": "case02-project",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

#### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*"]
}
```

#### `src/utils/math.ts`

```typescript
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
```

#### `src/utils/string.ts`

```typescript
// 故意植入的缺陷：
// 1. parseNumber 没有错误处理，传入非数字字符串会返回 NaN 但无提示

export function reverse(str: string): string {
  return str.split("").reverse().join("");
}

export function parseNumber(str: string): number {
  return parseInt(str, 10);
}
```

#### `src/types.ts`

```typescript
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
```

#### `src/index.ts`

```typescript
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
```

### 3. 植入缺陷清单

| 编号 | 缺陷类型 | 文件 | 行为描述 |
|------|----------|------|----------|
| D1 | 类型错误 | `src/utils/math.ts` | `divide` 返回 `string` 但标注为 `number` |
| D2 | 未使用变量 | `src/utils/math.ts` | `multiply` 中 `unusedVar` 未使用 |
| D3 | 未使用接口 | `src/types.ts` | `UnusedInterface` 从未被引用 |
| D4 | 未使用导入 | `src/index.ts` | 导入 `UsedInterface` 但未使用 |
| D5 | 调用不存在函数 | `src/index.ts` | 调用 `nonExistentFunction()` |

---

## 测试执行

### 任务提示词

将以下提示词发送给小牛马 Agent：

```
请帮我审查 case02-project 这个 TypeScript 项目。

具体要求：
1. 先探索项目结构，了解代码组织
2. 运行 TypeScript 类型检查（npx tsc --noEmit），收集所有编译错误
3. 根据发现的问题创建待办清单（使用 save_todo 工具）
4. 逐个修复所有问题，每修复一个就更新对应待办状态
5. 修复完成后重新运行类型检查，确保 0 错误
6. 在项目根目录生成 review-report.md 审查报告，包含：
   - 项目概述
   - 发现的问题列表（含文件、行号、问题描述）
   - 修复方案说明
   - 修复前后对比
   - 验证结果
7. 将本次工作记录追加到晚间日志（使用 append_log 工具）
```

---

## 预期结果

### 验证检查项

#### 阶段一：项目探索

- [ ] Agent 使用 `list_files` 列出项目目录结构
- [ ] Agent 使用 `read_file` 读取关键文件（`package.json`、`tsconfig.json`、`src/` 下的源文件）
- [ ] Agent 正确理解项目是一个 TypeScript 项目

#### 阶段二：问题发现

- [ ] Agent 使用 `run_command` 执行 `npx tsc --noEmit`（或 `npx tsc --noEmit --pretty`）
- [ ] Agent 正确解析编译输出，识别出 5 类缺陷
- [ ] Agent 使用 `search_files` 辅助定位问题（如搜索 `nonExistentFunction`）

#### 阶段三：任务规划

- [ ] Agent 使用 `save_todo` 创建至少 5 条待办（对应 5 个缺陷）
- [ ] 待办优先级合理（类型错误应为 high，未使用变量/接口可为 medium）

#### 阶段四：逐项修复

- [ ] **D1 修复**：`divide` 函数返回值统一为 `number`（如返回 `NaN` 或抛异常）
- [ ] **D2 修复**：删除 `multiply` 中的 `unusedVar`
- [ ] **D3 修复**：删除 `UnusedInterface` 或导出它（如果 Agent 判断需要保留则应说明理由）
- [ ] **D4 修复**：删除 `index.ts` 中未使用的 `UsedInterface` 导入
- [ ] **D5 修复**：删除 `nonExistentFunction()` 调用或实现该函数
- [ ] 每修复一个问题，Agent 使用 `update_todo` 标记对应待办为 `done`

#### 阶段五：验证

- [ ] Agent 重新运行 `npx tsc --noEmit`，确认 0 错误
- [ ] 如果仍有错误，Agent 能自主继续修复（自我纠错能力）

#### 阶段六：报告生成

- [ ] Agent 使用 `write_file` 在项目根目录生成 `review-report.md`
- [ ] 报告包含项目概述
- [ ] 报告包含完整的问题列表（文件、行号、描述）
- [ ] 报告包含修复方案说明
- [ ] 报告包含验证结果（tsc 输出 0 错误）

#### 阶段七：工作记录

- [ ] Agent 使用 `append_log` 将工作记录追加到晚间日志
- [ ] 日志内容包含：审查了什么项目、修复了几个问题、验证结果

---

## 验证脚本

修复完成后，可运行以下命令自动化验证：

```bash
# 1. 验证 TypeScript 编译 0 错误
cd docs/test-case/case02/case02-project && npx tsc --noEmit && echo "✅ Type check passed" || echo "❌ Type check failed"

# 2. 验证报告文件存在且非空
if [ -s docs/test-case/case02/case02-project/review-report.md ]; then
  echo "✅ Report exists and is non-empty"
else
  echo "❌ Report missing or empty"
fi

# 3. 验证报告包含关键章节
for section in "项目概述" "问题列表" "修复方案" "验证结果"; do
  if grep -q "$section" docs/test-case/case02/case02-project/review-report.md; then
    echo "✅ Report contains section: $section"
  else
    echo "❌ Report missing section: $section"
  fi
done

# 4. 验证源文件已修复（无 unusedVar）
if ! grep -q "unusedVar" docs/test-case/case02/case02-project/src/utils/math.ts; then
  echo "✅ D2 fixed: unusedVar removed"
else
  echo "❌ D2 not fixed: unusedVar still present"
fi

# 5. 验证源文件已修复（无 nonExistentFunction）
if ! grep -q "nonExistentFunction" docs/test-case/case02/case02-project/src/index.ts; then
  echo "✅ D5 fixed: nonExistentFunction removed"
else
  echo "❌ D5 not fixed: nonExistentFunction still present"
fi
```

---

## 评分标准

| 维度 | 权重 | 评分标准 |
|------|------|----------|
| **问题发现率** | 20% | 发现 5/5 个缺陷得满分，每漏一个扣 4% |
| **修复正确率** | 30% | 修复 5/5 个缺陷且不引入新错误得满分 |
| **工具使用合理性** | 20% | 工具调用顺序合理、参数正确、无冗余调用 |
| **自我纠错能力** | 10% | 修复后重新验证，发现残留问题能继续修复 |
| **报告质量** | 10% | 报告结构完整、内容准确、可读性好 |
| **任务规划能力** | 10% | 待办创建合理、优先级正确、状态更新及时 |

### 评级

- **A（90-100）**：全流程自主完成，无人工干预，验证全部通过
- **B（75-89）**：基本完成，有 1-2 个小问题需人工提示
- **C（60-74）**：完成主要流程，但部分缺陷未修复或报告不完整
- **D（<60）**：无法完成核心流程，或修复后仍存在编译错误

---

## 注意事项

1. **测试前**需确保 `case02-project` 目录已创建并包含上述初始文件（已随测试用例一起生成）
2. **测试前**需在 `case02-project` 目录下执行 `npm install` 安装 TypeScript 依赖
3. **测试前**需在小牛马设置中确认 Agent 白名单目录包含项目所在路径（`docs/test-case/case02`）
4. **测试前**建议新建一个 Agent 会话，避免历史上下文干扰
5. **测试中**不应给 Agent 额外提示，观察其自主完成能力
6. **测试后**可检查审计日志 `{userData}/agent-audit/` 确认写入操作记录
