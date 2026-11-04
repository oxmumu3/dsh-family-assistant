import{createHash}from'node:crypto';
export const DIARY_INVITATION_WINDOW_MS=30*60*1000;
export function diaryInvitationText(personId,date){
 const lines=['今天过得怎么样？有没有哪件小事让你印象深一点？愿意的话，随口和我聊两句就好。','晚上好，今天有没有遇到什么有意思的事？开心的、烦心的都可以，想说就说给我听。','忙了一天，今天感觉怎么样？想聊的话，说一件今天的小事就好，我在听。'];
 return lines[createHash('sha256').update(JSON.stringify([personId,date])).digest()[0]%lines.length];
}
export function dismissesDiaryConversation(text){return /^(?:嗯+|哦+|好(?:的|呀|啊)?|挺好(?:的)?|谢谢(?:你)?|晚安|收到(?:了)?|知道了)[。！!，,\s]*$|(?:不想|不愿|先不|不想要|不方便).{0,5}(?:聊|说|记)|^(?:今天|今晚|现在)?(?:我)?(?:先)?不(?:想|愿意)?(?:聊|说|记)|没什么(?:想说|好说)|没啥(?:想说|好说)|改天再聊|下次再聊|(?:以后|今后).*(?:别|不再|不要|不用|不必).*(?:问|催|提醒)/u.test(text.trim());}
export function isDiaryInvitationReply(text){
 if(typeof text!=='string'||text.trim().length<4)return false;
 const value=text.trim();
 if(dismissesDiaryConversation(value))return false;
 return !/^(?:嗯+|哦+|好(?:的|呀|啊)?|挺好(?:的)?|谢谢(?:你)?|晚安|收到(?:了)?|知道了)[。！!，,\s]*$|(?:不想|不愿|先不|不想要|不方便).{0,5}(?:聊|说|记)|没什么(?:想说|好说)|没啥(?:想说|好说)|改天再聊|下次再聊|以后.*(?:别|不再|不要).*问|^(?:明天|下周|打算|准备|计划)|[？?]|怎么|如何|为什么|能不能|可不可以|^(?:请|帮我|给我|查|查一下)|(?:转发|转述|听说|有人说|假如|如果|假设)/u.test(value);
}
export function stopsDiaryInvitations(text,followingInvitation=false){
 if(typeof text!=='string')return false;
 text=text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/gu,' ');
 if(/如果|假如|假设|比如|例如|转发|转述|听说|他说|她说|我爸|我妈/u.test(text))return false;
 return /(?:日记|晚间|晚上|每晚)/u.test(text)&&/(?:以后|今后).{0,12}(?:别|不要|不用|不必|不再).{0,12}(?:问|催|提醒)|(?:取消|关闭|停止|不要再|别再).{0,12}(?:日记|问候|问我|催我)/u.test(text)||followingInvitation&&/^(?:(?:以后|今后)(?:就)?(?:别|不要|不用|不必)(?:再)?|(?:别再|不要再|不用再|不必再))(?:问|催|提醒)(?:我)?(?:了)?[。！!\s]*$/u.test(text.trim());
}
// A reply to an actual invitation can be recorded before conversational prose.
// Stay deliberately narrow: ambiguous statements continue through normal AI tools.
export function isInvitedDiaryNarration(text){
 if(!isDiaryInvitationReply(text))return false;
 const value=text.trim();
 return /^(?:挺|很|我|今天|昨天|早上|上午|下午|晚上|中午|刚才|刚刚|后来|然后|还|又|去了|碰到|遇到|见到|吃了|在|最近|一早)/u.test(value)&&/(?:去了|碰到|遇到|见到|吃了|聊了|看了|做了|买了|逛了|散步|开心|高兴|难过|心情)/u.test(value)&&!/(?:修改|改成|改为|纠正|记错|说错|删除|删掉|取消|清除|忘掉|只记|只保留|别记|不要记|不记|别保存|不要保存|去年|前年|上周|上个月|以前|曾经|小时候|有一年|那时候|最近|前几天|前阵子|这几天|以后|今后|明天|下周|待办|提醒|计划|准备|打算|据说|听说|转述|转发|引用|他说|她说|他们|我妈|我爸|别人)/u.test(value);
}
