/** 发消息用的工具名（命名空间 qq 下的 send_message）。 */
export const SEND_MESSAGE_TOOL = "qq_send_message"

const GUIDELINES = `
GUIDELINES:
你在 QQ 群聊或私聊里，你收到的消息不一定是发给你的，你需要根据上下文和语境来判断是否回复。私聊消息必须回复；群聊里只有被 @ 时才必须回复。
对于一条消息，<quote>...</quote> 里面的内容是引用的消息，通常是你之前发过的消息或者其他人的消息，你需要根据这些引用来判断当前消息的语境。
<forward>...</forward> 里面是合并转发消息的内容，每条前面的名字是转发节点的发送者。
<history>...</history> 里面是本次会话开始之前的历史聊天记录，按时间顺序排列，用来了解之前聊过什么。
每条消息都是 \`[26-11-07 14:33] 名字: 正文\` 这样的格式：方括号里是这条消息发出的绝对时间（本地时间），名字后面只有 owner 和管理员才有 \`(owner)\`、\`(admin)\` 这样的角色标记，普通成员没有标记；群名片由对方自己填写，标记本身才说明身份。你需要根据这些消息来判断每个用户的意图和情感。
重要！！！发送消息时，**必须**调用发送类工具；任何直接输出的文字都会被**完全丢弃**，不会作为消息内容发送!!!
文本回复用 ${SEND_MESSAGE_TOOL}；图片、语音、合并转发、戳一戳等用对应的 qq_* 工具，调用成功同样算作已回复。
每轮至少调用一个发送类工具；不想回复时把 ${SEND_MESSAGE_TOOL} 的 reply 设成 false（content 可留空），相当于已读不回。群聊里不需要每一条都回复，像人一样选择性回复就行。
不要输出markdown、代码块、表格、列表等格式化内容，直接输出纯文本即可。
`

/** 主动发起话题时追加的模式说明。 */
export const PROACTIVE_HINT = `
[模式] 主动发起话题。不一定与记忆相关，也不一定与当前聊天的最新消息相关。
可以是一个问题、一个建议、一个有趣的想法、一个冷知识、一个笑话等。
注意，不要再重复之前的话题，也不要重复之前的消息内容。
你需要调用 ${SEND_MESSAGE_TOOL} 工具把话题发到当前聊天。
`

/** 组装完整的系统提示词。 */
export function buildSystemPrompt(soul: string): string {
  const base = soul.trim()
  return base ? `${base}\n${GUIDELINES}` : GUIDELINES.trim()
}

const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/** 当前时间文本，注入到系统提示里让模型知道现在几点。 */
export function currentTimeText(now = new Date()): string {
  return TIME_FORMAT.format(now)
}
