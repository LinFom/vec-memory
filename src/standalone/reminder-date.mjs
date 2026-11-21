// Calendar expressions are anchored to the source timestamp. A day without a
// clock stays day precision; midnight represents its interval boundary only.
const dayMs = 86400000;
const chinese = {零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function integer(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.includes('十')) { const [a,b] = value.split('十'); return (a ? chinese[a] : 1) * 10 + (b ? chinese[b] : 0); }
  return chinese[value];
}
export function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(timestamp);
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function instant(year,month,day,hour,minute,timeZone) {
  const local = Date.UTC(year,month-1,day,hour,minute), check = new Date(Date.UTC(year,month-1,day));
  if (check.getUTCFullYear()!==year || check.getUTCMonth()!==month-1 || check.getUTCDate()!==day || hour>23 || minute>59) return null;
  let value = local;
  for(let n=0;n<3;n++) {
    const p = zonedParts(value,timeZone);
    value += local-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
  }
  const p=zonedParts(value,timeZone);
  return p.year===year && p.month===month && p.day===day && p.hour===hour && p.minute===minute ? value : null;
}
export function resolveReminderDate(text, timestamp, timeZone='UTC') {
  let anchor;
  try { anchor=zonedParts(timestamp,timeZone); } catch { return null; }
  const pattern=/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]|(今天|明天|后天|大后天|月底)|(?:(本|这|下)周|星期|周)([一二三四五六日天])/gu;
  const dates=[...text.matchAll(pattern)];
  if(dates.length!==1)return null;
  const match=dates[0];
  let year=anchor.year,month=anchor.month,day=anchor.day;
  if(match[2]) { year=match[1]?Number(match[1]):year;month=Number(match[2]);day=Number(match[3]); }
  else {
    let delta=0;
    if(match[4]==='月底')day=new Date(Date.UTC(year,month,0)).getUTCDate();
    else if(match[4])delta={今天:0,明天:1,后天:2,大后天:3}[match[4]];
    else {
      const weekday=new Date(Date.UTC(year,month-1,day)).getUTCDay()||7;
      const target={一:1,二:2,三:3,四:4,五:5,六:6,日:7,天:7}[match[6]];
      delta=target-weekday+(match[5]==='下'?7:0);
      if(!match[5] && delta<0)delta+=7;
    }
    const d=new Date(Date.UTC(year,month-1,day)+delta*dayMs);year=d.getUTCFullYear();month=d.getUTCMonth()+1;day=d.getUTCDate();
  }
  const tail=text.slice(match.index+match[0].length);
  const clock=/^\s*(?:(凌晨|早上|上午|中午|下午|晚上)\s*)?([零一二两三四五六七八九十\d]{1,3})(?:点|时|:|：)(?:([零一二三四五六七八九十\d]{1,3})分?|半)?/u.exec(tail);
  // A part of day without a clock has no exact instant.
  if(!clock && /^\s*(?:凌晨|早上|上午|中午|下午|晚上)/u.test(tail))return null;
  let hour=0,minute=0;
  if(clock) {
    hour=integer(clock[2]);minute=clock[3]?integer(clock[3]):clock[0].endsWith('半')?30:0;
    if(clock[1] && hour>12)return null;
    if(['下午','晚上'].includes(clock[1]) && hour<12)hour+=12;
    if(clock[1]==='中午' && hour<11)hour+=12;
    if(clock[1]==='凌晨' && hour===12)hour=0;
    if(!Number.isInteger(hour)||!Number.isInteger(minute))return null;
  }
  const dueAt=instant(year,month,day,hour,minute,timeZone);
  if(dueAt===null)return null;
  return {dueAt,duePrecision:clock?'minute':'day',start:match.index,end:match.index+match[0].length+(clock?.[0].length||0)};
}
