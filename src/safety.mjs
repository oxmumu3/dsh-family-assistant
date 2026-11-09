// A deterministic first line of defence for family members. It never asks a
// model what to do: the checklist is fixed, short, and identical every time, so
// a rushed or frightened person can act on it without reading twice.

const SIGNALS = [
  ['安全账户', /安全账户|资金审查|账户(?:涉嫌|异常)|配合调查|通缉令|逮捕令/],
  ['转账汇款', /转账|汇款|打款|转给.{0,6}(?:账户|卡号)|垫付/],
  ['验证码', /验证码|短信码|动态码|口令卡/],
  ['中奖返利', /中奖|返利|刷单|返现|内部(?:名额|渠道)|稳赚/],
  ['退款理赔', /退款|理赔|客服.{0,8}(?:退款|理赔|赔偿)|快递.{0,6}(?:丢|损)/],
  ['贷款额度', /贷款|额度|提额|免息/],
  ['陌生链接', /点击.{0,4}链接|扫(?:码|这个码)|下载.{0,6}(?:App|软件)|加.{0,4}(?:QQ|群)/],
];

export function safetyCard(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim();
  if (!body || body.length > 1200) return null;
  const hits = SIGNALS.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
  if (!hits.length) return null;
  // A question about "什么是骗子" is a conversation, not a live risk.
  if (/什么是|怎么识别|如何识别|新闻|科普|案例/.test(body) && !/让我|要我|叫我|刚收到|刚接|发给我的/.test(body)) return null;
  const label = hits[0];
  return {
    category: label,
    reply: [
      `先别转账，也别点链接。这句话里有骗子常用的说法（${label}）。`,
      '',
      '可以这样做：',
      '1. 先挂断，或者先不回；',
      '2. 打银行卡背面的电话，或者打 110 问一句；',
      '3. 真要告诉家里人，就说「转告家里人」，我把这条转给他们。',
      '',
      '要是你想聊别的，直接说就行。',
    ].join('\n'),
  };
}
