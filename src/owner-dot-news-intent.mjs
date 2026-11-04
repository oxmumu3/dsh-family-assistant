// Routing only: Dot separately authenticates the active call and derives every
// value from the original Owner text. Member/file-delivery flows stay separate.
export function isOwnerDotNewsIntent(value){
 if(typeof value!=='string'||value.length>1000)return false;
 const text=value.trim().replace(/[。！!]+$/u,'').replace(/^(?:请|帮我|麻烦)\s*/u,'').replace(/\s+/gu,'');
 if(/^(?:AI(?:精选)?(?:日报|digest)|看(?:一下)?AI日报|今天的AI精选|(?:预览|先看看|查看)(?:一份)?AI日报)(?:[，,](?:使用已保存的关注点|按我的关注点))?$/iu.test(text))return true;
 if(/^(?:现在)?(?:给我)?(?:发送|发)(?:给我)?(?:一份|一次|今天的)?AI日报(?:[，,](?:使用已保存的关注点|按我的关注点))?$/iu.test(text))return true;
 if(/^(?:取消|关闭|停止|开启|启用)(?:我的)?AI日报(?:推送)?$/iu.test(text))return true;
 if(/^(?:查看|看看|查询)(?:我的)?(?:AI)?(?:资讯(?:兴趣|状态)|日报(?:关注点|兴趣|状态))$/iu.test(text))return true;
 if(/^(?:清空|清除)(?:我的)?(?:AI)?(?:资讯兴趣|日报关注点)$/iu.test(text))return true;
 if(/^(?:(?:把|将)?(?:我的)?(?:AI)?资讯兴趣(?:设为|设置为|改为)[：:]|(?:我的)?AI日报(?:主要)?关注[：:]?)[^。！？!?；;\n]+$/iu.test(text))return true;
 return /^(?:北京时间|墨西哥城时间)?每天(?:早上|上午|中午|下午|晚上)?(?:\d{1,2}|[一二两三四五六七八九十]{1,3})(?:[:：]\d{2}|点(?:\d{1,2}分)?)[，,]?(?:按我的关注点)?(?:给我)?(?:发|发送)AI日报(?:[，,]使用已保存的关注点)?$/iu.test(text);
}
