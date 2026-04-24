/**
 * StatusBubble 文案池
 *
 * 每条文案有：
 *  - when(context):  判定是否适配当前上下文（true 才会参与抽签）
 *  - text(context):  最终显示文本（可以根据 context 动态拼接）
 *  - weight:         权重（影响抽中概率，默认 1）
 *  - cooldownMs?:    冷却时间（抽中后多久内不能再选中），用于避免同一条反复出现
 *
 * 上下文 `BubbleContext` 涵盖：时间段 / 星期几 / 待办 / 心情/饿肚子 / 离上次流程多久
 */

export interface BubbleContext {
  /** 小时 0-23 */
  hour: number
  /** 星期 0=日 ~ 6=六 */
  dayOfWeek: number
  /** 今日待办总数 */
  todoTotal: number
  /** 今日未完成待办数 */
  todoPending: number
  /** 心情值 0-100 */
  mood: number
  /** 饱食度 0-100 */
  hunger: number
  /** 心情档位 */
  tier: 'hungry' | 'sad' | 'ok' | 'great'
  /** 距离本窗口启动时间（毫秒），用于"刚进来"类文案 */
  sinceMountMs: number
  /** 距离上次喂食（毫秒）。从未喂过则为 +∞ */
  sinceFedMs: number
  /** 距离上次抚摸（毫秒）。从未抚摸则为 +∞ */
  sinceInteractMs: number
}

export interface BubbleLine {
  id: string
  when?: (c: BubbleContext) => boolean
  text: (c: BubbleContext) => string
  weight?: number
  cooldownMs?: number
}

const isWeekend = (c: BubbleContext) => c.dayOfWeek === 0 || c.dayOfWeek === 6
const isMorning = (c: BubbleContext) => c.hour >= 6 && c.hour < 11
const isNoon = (c: BubbleContext) => c.hour >= 11 && c.hour < 14
const isAfternoon = (c: BubbleContext) => c.hour >= 14 && c.hour < 18
const isEvening = (c: BubbleContext) => c.hour >= 18 && c.hour < 22
const isLate = (c: BubbleContext) => c.hour >= 22 || c.hour < 6

/** 文案池 */
export const BUBBLE_LINES: BubbleLine[] = [
  // ── 饿肚子（最高优先级）──
  {
    id: 'hungry-1',
    when: c => c.hunger < 25,
    text: () => '肚子咕噜噜…给我点吃的嘛～',
    weight: 5,
    cooldownMs: 60_000,
  },
  {
    id: 'hungry-2',
    when: c => c.hunger < 15,
    text: () => '喵喵喵！饿瘪啦 (≧﹏≦)',
    weight: 6,
    cooldownMs: 45_000,
  },

  // ── 心情差 ──
  {
    id: 'sad-1',
    when: c => c.mood < 30 && c.hunger >= 25,
    text: () => '摸摸我…最近压力好大哇',
    weight: 3,
    cooldownMs: 90_000,
  },
  {
    id: 'sad-2',
    when: c => c.mood < 40 && c.todoPending > 8,
    text: c => `待办还有 ${c.todoPending} 条，别急，一个一个来～`,
    weight: 3,
  },

  // ── 心情好 ──
  {
    id: 'great-1',
    when: c => c.mood >= 85,
    text: () => '今天好开心呀 (๑•̀ㅂ•́)و✧',
    weight: 2,
    cooldownMs: 120_000,
  },
  {
    id: 'great-2',
    when: c => c.mood >= 80 && c.todoPending === 0 && c.todoTotal > 0,
    text: () => '今日待办都搞定啦！来夸夸我 (´• ω •`)',
    weight: 4,
  },

  // ── 时间段通用 ──
  {
    id: 'morning-1',
    when: isMorning,
    text: () => '早上好呀～今天做点什么呢？',
    weight: 2,
    cooldownMs: 180_000,
  },
  {
    id: 'morning-2',
    when: c => isMorning(c) && c.todoTotal === 0,
    text: () => '要不要先录一下今日计划？右键菜单喔',
    weight: 3,
  },
  {
    id: 'noon-1',
    when: isNoon,
    text: () => '吃饭时间到～记得按时吃饭喵',
    weight: 2,
    cooldownMs: 180_000,
  },
  {
    id: 'afternoon-1',
    when: isAfternoon,
    text: () => '下午也要加油呀！(๑•̀ㅂ•́)و',
    weight: 2,
  },
  {
    id: 'afternoon-2',
    when: c => isAfternoon(c) && c.todoPending > 0,
    text: c => `还有 ${c.todoPending} 个待办没做完哦～`,
    weight: 3,
  },
  {
    id: 'evening-1',
    when: isEvening,
    text: () => '晚上了～要不要记一下今天做了什么？',
    weight: 3,
    cooldownMs: 180_000,
  },
  {
    id: 'late-1',
    when: isLate,
    text: () => '这么晚了还在工作？早点休息嘛 (｡•́︿•̀｡)',
    weight: 4,
    cooldownMs: 300_000,
  },

  // ── 周末/工作日差异 ──
  {
    id: 'weekend-1',
    when: c => isWeekend(c) && c.hour >= 9 && c.hour < 18,
    text: () => '周末啦～放松点哈 ฅ(^•ω•^ฅ)',
    weight: 2,
    cooldownMs: 300_000,
  },
  {
    id: 'monday-1',
    when: c => c.dayOfWeek === 1 && isMorning(c),
    text: () => '周一加油！新的一周要元气满满～',
    weight: 3,
  },
  {
    id: 'friday-1',
    when: c => c.dayOfWeek === 5 && isAfternoon(c),
    text: () => '星期五啦！今天熬过去就放假 (oﾟvﾟ)ノ',
    weight: 3,
  },

  // ── 即时反馈：刚被喂过 ──
  {
    id: 'just-fed-1',
    when: c => c.sinceFedMs < 60_000, // 1 分钟内
    text: () => '好好吃呀～谢谢主人 (๑´ڡ`๑)',
    weight: 10,
    cooldownMs: 90_000,
  },
  {
    id: 'just-fed-2',
    when: c => c.sinceFedMs >= 60_000 && c.sinceFedMs < 180_000, // 1-3 分钟
    text: () => '刚吃饱，舒服～',
    weight: 4,
    cooldownMs: 180_000,
  },
  // ── 即时反馈：刚被抚摸 ──
  {
    id: 'just-pet-1',
    when: c => c.sinceInteractMs < 30_000, // 30 秒内
    text: () => '呼噜噜~ (=^･ω･^=)',
    weight: 8,
    cooldownMs: 60_000,
  },
  {
    id: 'just-pet-2',
    when: c => c.sinceInteractMs < 60_000 && c.mood > 70,
    text: () => '再摸摸嘛～',
    weight: 3,
    cooldownMs: 90_000,
  },
  // ── 久未互动 ──
  {
    id: 'lonely-1',
    when: c => c.sinceInteractMs > 30 * 60_000 && c.sinceInteractMs !== Infinity,
    text: () => '好久没摸我啦…孤单中 (｡•́︿•̀｡)',
    weight: 2,
    cooldownMs: 600_000,
  },

  // ── 闲聊/陪伴类（权重低但能在各种上下文出现）──
  {
    id: 'chat-1',
    text: () => '需要帮忙就双击我呀～（打开 AI 对话）',
    weight: 1,
    cooldownMs: 240_000,
  },
  {
    id: 'chat-2',
    text: () => '喵～ ( ฅ`ω´ฅ)',
    weight: 1,
    cooldownMs: 120_000,
  },
  {
    id: 'chat-3',
    text: () => '记得站起来动一动腰呀',
    weight: 1,
    cooldownMs: 300_000,
  },
  {
    id: 'chat-4',
    text: () => '喝口水吧～',
    weight: 1,
    cooldownMs: 300_000,
  },
  {
    id: 'chat-5',
    text: () => '偷偷观察你好久啦 (•ω•)',
    weight: 1,
    cooldownMs: 300_000,
  },
  {
    id: 'chat-6',
    text: () => '右键我可以录计划/查看待办哦',
    weight: 1,
    cooldownMs: 300_000,
  },

  // ── 待办相关 ──
  {
    id: 'todo-1',
    when: c => c.todoTotal > 0 && c.todoPending === 0,
    text: () => '所有待办都完成了？！你真棒 (づ｡◕‿‿◕｡)づ',
    weight: 5,
    cooldownMs: 600_000,
  },
  {
    id: 'todo-2',
    when: c => c.todoPending === 1,
    text: () => '就差最后一个待办啦！冲鸭～',
    weight: 3,
  },
  {
    id: 'todo-3',
    when: c => c.todoPending >= 10,
    text: c => `${c.todoPending} 条待办…深呼吸，一口一口吃`,
    weight: 2,
  },
]

/** 冷却缓存：id → 最近一次被选中的时间戳 */
const cooldownMap = new Map<string, number>()

/** 按权重 + 冷却挑一条文案。none 意味着当前没有合适文案 */
export function pickBubble(ctx: BubbleContext): BubbleLine | null {
  const now = Date.now()
  const candidates = BUBBLE_LINES.filter(line => {
    if (line.when && !line.when(ctx)) return false
    const last = cooldownMap.get(line.id) ?? 0
    const cd = line.cooldownMs ?? 30_000
    if (now - last < cd) return false
    return true
  })
  if (candidates.length === 0) return null
  const totalWeight = candidates.reduce((s, l) => s + (l.weight ?? 1), 0)
  let r = Math.random() * totalWeight
  for (const line of candidates) {
    r -= line.weight ?? 1
    if (r <= 0) {
      cooldownMap.set(line.id, now)
      return line
    }
  }
  const picked = candidates[candidates.length - 1]
  cooldownMap.set(picked.id, now)
  return picked
}
