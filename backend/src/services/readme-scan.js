// README 텍스트와 검색 응답 메타만 읽어 판정한다. 링크·첨부·코드는 내려받거나 실행하지 않는다.
export const RULE_VERSION = 2;

const MAX_README_BYTES = 512 * 1024;
const MAX_EVIDENCE = 500;
// 저장·실행 파일 이름은 구간 앞부분에서만 찾는다. 정상 명령은 이보다 짧고, 긴 구간을 통째로 훑으면 선형 시간을 지킬 수 없다.
const MAX_SEGMENT_CHARS = 1000;

// 모든 정규식은 한 지점에서 고정 길이 또는 서로 겹치지 않는 반복만 쓴다. 긴 줄에서 역추적이 폭증하지 않게 하기 위함이다.
const FETCH = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl(?:\.exe)?|wget)\b/i;
const REMOTE_TARGET = /https?:\/\/|[\w-]\.[a-z]{2,}\//i;
const RUN_POWERSHELL = /^\s*(?:iex\b|invoke-expression\b|&\s*\(\s*(?:gcm|get-command)\s+i\S{0,4}x\s*\))/i;
const RUN_SHELL = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da)?sh\b/i;
const INLINE_IEX = /\b(?:iex|invoke-expression)\b[\s("'$&{]*(?:irm|iwr|invoke-restmethod|invoke-webrequest|new-object\s+(?:system\.)?net\.webclient)\b/i;
// 받은 내용을 파이프 없이 바로 실행하는 치환 형태.
const SUBST_SHELL = /(?:\b(?:ba|z|da)?sh|\bsource|\beval|(?:^|[\s;&|(])\.)\s+(?:--?[\w-]+\s+){0,6}["']?[<$]\(\s*(?:sudo\s+)?(?:curl|wget)\b([^)\n]{0,300})\)/i;
const SUBST_POWERSHELL = /\[scriptblock\]::create\([^\n]{0,40}?\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i;
// 만든 scriptblock을 실제로 호출해야 실행이다: `& ([scriptblock]::Create(…))`, `….Invoke()`, `Invoke-Command`, 변수에 담은 뒤 `& $변수`.
const SCRIPTBLOCK_DIRECT = /&[\s(]*\[scriptblock\]::create\(|\b(?:icm|invoke-command)\b[^\n;|[]{0,60}\[scriptblock\]::create\(|\[scriptblock\]::create\([^\n]{0,400}?\)\s*\)?\.invoke/i;
// 실행기에 명령 문자열을 넘기는 형태(`bash -c "…"`, `powershell -Command "…"`, `cmd /c "…"`). 따옴표 안을 명령으로 다시 나눈다.
const INNER_COMMAND = /^\s*(?:\S*[\\/])?(?:(?:ba|z|da)?sh\s+(?:-[a-z]+\s+){0,4}-[a-z]*c|(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+\s+){0,4}-c(?:ommand)?|cmd(?:\.exe)?\s+\/[ck])\s+(["'])([^"'\n]{1,1000})\1/i;
const SCRIPTBLOCK_ASSIGNED = /(?:^|[;\s])\$(\w{1,60})\s*=\s*\[scriptblock\]::create\(/i;
const MSHTA = /\bmshta(?:\.exe)?["']?\s+["']?(?:https?:\/\/|(?:javascript|vbscript):[^\n]{0,200}?https?:\/\/)/i;
// 파이프 오른쪽 셸이 표준 입력이 아니라 이름 붙은 스크립트를 실행하면(`curl … -o a.sh | bash b.sh`) 받은 내용을 실행하는 것이 아니다.
const SCRIPT_ARGUMENT = /[\\/]|\.(?:sh|bash|zsh|ksh|py|pl|rb|ps1|bat|cmd)$/i;
const READS_STDIN = /^(?:-|\/dev\/stdin|-[a-z]*s[a-z]*)$/i;

// 저장 후 실행: 원격 주소를 파일로 받는 명령과, 그 파일을 실행하는 뒤따르는 명령.
const SAVE_TOOL = /\b(curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest|certutil|bitsadmin|start-bitstransfer|downloadfile)\b/i;
const SAVE_AT_START = /^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest|certutil|bitsadmin|start-bitstransfer)(?:\.exe)?$/i;
const READER = /^(?:cat|type|get-content|gc|more|less|head|tail|grep|select-string)$/i;
const REDIRECT = />\s*["']?([^\s"'<>|;&()]{1,200})/;
const URL_NAME = /(?:https?:\/\/)?[\w.-]{1,253}\.[a-z]{2,}\/(?:[^\s"'<>|;&()?#]*\/)?([^\s"'<>|;&()?#/]{1,200})/i;
const OUT_FILE = {
  curl: /\s(?:-[a-zA-Z]*o|--output)\s+["']?([^\s"']{1,200})/,
  wget: /\s(?:-[a-zA-Z]*O|--output-document)(?:\s+|=)?["']?([^\s"']{1,200})/,
  powershell: /\s-o(?:ut(?:file)?)?\s+["']?([^\s"';|]{1,200})/i,
  certutil: /-urlcache\b[^\n]{0,80}?https?:\/\/\S+\s+["']?([^\s"']{1,200})/i,
  bitsadmin: /\/transfer\b[^\n]{0,120}?https?:\/\/\S+\s+["']?([^\s"']{1,200})/i,
  'start-bitstransfer': /-destination\s+["']?([^\s"']{1,200})/i,
  downloadfile: /downloadfile\(\s*["'][^"'\n]{1,300}["']\s*,\s*["']([^"'\n]{1,200})["']/i,
};
const REMOTE_NAME = /\s(?:-[a-zA-Z]*O\b|--remote-name\b)/;
const RUN_WINDOW = 3;
const MAX_SAVED_NAMES = 20;
const RUNNER = /^(?:(?:powershell|pwsh|cmd|wscript|cscript|msiexec)(?:\.exe)?|(?:ba|z|da)?sh|source|\.|start|start-process|&|python3?)$/i;
const PROMPT = /^(?:[$>#%]|PS>?)$/i;
// 다른 명령을 감싸 실행하는 말. 자기 옵션(과 값을 받는 옵션의 값)·환경 변수 지정을 건너뛰고 뒤 명령을 본다.
const WRAPPER = /^(?:sudo|doas|env|nohup|time)$/i;
const WRAPPER_FLAG_WITH_VALUE = /^(?:-[ugUhpCDRTfo]|--(?:user|group|host|prompt|chdir|unset|format|output|role|type|other-user|chroot|close-from))$/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
// 뒤에 적힌 것을 실행하지 않는 말(글자로 내보내기, 아무 일도 하지 않기). 이런 말로 시작하는 문은 실행·저장 판정에서 뺀다.
const INERT = /^(?:echo|printf|rem|write-host|write-output|true|false|:)$/i;
const INERT_HINT = /\b(?:echo|printf|rem|write-host|write-output|true|false)\b|(?:^|[;&|]\s*):\s/i;
const RUN_TOKENS = 40;
const TOKEN = /"[^"]*"|'[^']*'|\S+/g;
const RUN_FLAG = /^(?:-|\/\/|\/[a-z]{1,8}$)/i;
// 값을 따로 받는 PowerShell 옵션. 그 값("Bypass", "Hidden", "Text")을 실행 파일로 읽지 않게 건너뛴다.
const FLAG_WITH_VALUE = /^-(?:ex(?:ec(?:utionpolicy)?)?|ep|w(?:indowstyle)?|inputformat|if|outputformat|of|version|workingdirectory|wd|configurationname|config|psconsolefile|settingsfile|settings|custompipename)$/i;
// 모듈·한 줄 코드를 실행하는 python 호출은 뒤 인자가 실행 파일이 아니라 데이터다.
const PYTHON_INLINE = /^-[mc]$/;
// 파일을 실행하지 않고 문법 검사·버전·도움말만 내는 옵션.
const NO_EXEC_FLAG = /^(?:-n|-V|-h|-\?|\/\?|--help|--version|--syntax-check)$/;
const NO_EXEC_INLINE = /\s(?:-n|--help|--version|-\?)(?=\s)/;
const MAX_RUNNER_DEPTH = 3;

// 인코딩 명령은 풀린 본문에 같은 규칙을 한 번만 적용한다.
const ENCODED = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n|;&]{0,200}?\s-(?:e|ec|en|enc|enco[a-z]*)\s+["']?([A-Za-z0-9+/]{16,}={0,2})/gi;
const MAX_DECODES = 20;
const MAX_ENCODED_CHARS = 10924;

const PROTECTION = String.raw`(?:real-?\s?time\s+protection|tamper\s+protection|(?:windows\s+|microsoft\s+)?defender|anti-?virus(?:\s+software)?|virus\s*(?:&|and)\s*threat\s+protection)`;
const QUOTE = String.raw`["'“”‘’*_\x60]`;
const FILLER = String.raw`(?:(?:the|your|any|all|temporarily|briefly|windows|microsoft|${QUOTE})\s*)*`;
// 보호 기능 자체를 끄는 지시만 인정한다. 알림 끄기·예외 등록·SmartScreen 통과 안내는 해당하지 않는다(R2.3).
const PROTECTION_OFF = [
  new RegExp(String.raw`\b(?:disable|turn\s+off|switch\s+off|pause|deactivate|stop|uninstall)\s+${FILLER}${PROTECTION}`, 'gi'),
  new RegExp(String.raw`${PROTECTION}${QUOTE}*\s*(?:is\s+|are\s+|must\s+be\s+|should\s+be\s+|needs\s+to\s+be\s+)?(?:turned\s+off|switched\s+off|off|disabled|paused)\b`, 'gi'),
  /\bSet-MpPreference\b[^\n]{0,200}?-Disable\w*\s+(?:\$?true|1)\b/gi,
  /\b(?:sc(?:\.exe)?|net)\s+stop\s+["']?WinDefend\b/gi,
  /\bStop-Service\b[^\n]{0,60}?\bWinDefend\b/gi,
  /\bDisable(?:AntiSpyware|RealtimeMonitoring)\b[^\n]{0,80}?(?:\/d\s+1\b|-Value\s+1\b|=\s*1\b|dword:0{0,7}1\b)/gi,
];
// 보호 대상을 일반 명사로 쓴 문구는 코드 없는 저장소에서만 인정한다(D-010). "firewall rule", "firewall service"처럼
// 다른 것을 가리키는 말과 섞이지 않게, 대상 바로 뒤에서 구가 끝나는 경우만 받는다.
const GENERIC_OFF = new RegExp(
  String.raw`\b(?:disable|turn\s+off|switch\s+off|pause|deactivate|uninstall)\s+${FILLER}(?:security\s+(?:software|programs?|tools?|suites?)|firewall)`
  + String.raw`(?=\s*(?:[.,;:!)]|$|(?:before|first|temporarily|while|during|then|until)\b|to\s+(?:install|run|continue|avoid|prevent|proceed)\b))`,
  'gi',
);
const GENERIC_HINT = /firewall|security\s/i;
// 일반 명사 문구는 흔한 말이라 더 엄격하게 본다: 문장 어디에든 부정·금지·조건 표현이나 부속 대상(알림·규칙·로그)이 있으면 버리고,
// 끄라는 말로 문장이 시작할 때만(앞에는 목록 표시와 please·first·you must 같은 지시어만) 명령형으로 인정한다.
const GENERIC_NEGATED = /\b(?:never|not|no|without|unnecessary|avoid|instead|rather|unless|if|whether)\b|n['’]t\b/i;
const GENERIC_SIDE = /\b(?:notifications?|alerts?|pop-?ups?|prompts?|warnings?|rules?|logs?|logging)\b/i;
const GENERIC_LEAD_MAX = 60;
const GENERIC_SENTENCE_START = /^(?:[-*+>#\s"'“”‘’*_\x60]|\d+[.)])*(?:(?:please|first|then|next|now|also|temporarily|briefly|simply|just|step\s*\d+)[\s,:.)-]*)*(?:you\s+(?:must|should|need\s+to|have\s+to)\s+(?:first\s+|temporarily\s+)?)?$/i;
const CODELESS_MAX_SIZE_KB = 100;
// 1판의 부정 판정(앞 30자). 2판 판정이 1판보다 넓어지지 않도록 그대로 함께 쓴다(R4.1).
const NEGATION_V1 = /\b(?:never|not|don't|do\s+not|doesn't|no\s+need\s+to|without)\s+(?:\w+\s+){0,2}$/i;
const NEGATION_MORE = /(?:\b(?:cannot|never,?\s+ever|no\s+reason\s+to|unnecessary\s+to)|n['’]t)[\s,]+(?:\w+\s+){0,3}$/i;
// "Do not, under any circumstances, disable …"처럼 부정어 뒤에 쉼표로 끼운 말이 있는 금지문.
const NEGATION_ASIDE = /\b(?:never|not|don't|do\s+not|must\s+not|should\s+not|shouldn't|cannot|can't),\s*[^,.;:]{1,60},\s*(?:\w+\s+){0,2}$/i;
const DOUBLE_NEGATIVE = /\b(?:forget|fail|neglect|hesitate)\s+to\s+(?:\w+\s+){0,2}$/i;
// 지시가 아니라 가정·서술인 문장: "If you disable …, the installer refuses", "malware that tries to disable …".
const NOT_INSTRUCTION = /\b(?:if\s+you|when\s+you|(?:tries|tried|trying|attempts?|attempted|attempting)\s+to)\s+$/i;
const EXCLUSION = /\b(?:exclusions?|exceptions?|whitelist|allow-?list)\b/i;
// "Defender notifications", "antivirus update notifications", "Defender telemetry"처럼 보호 기능이 아닌 부속 대상을 끄는 안내는 제외한다.
const SIDE_TARGET = /^[\s"'“”‘’*_\x60]{0,3}(?:(?!(?:and|or|then|to|before|after|if|when|while)\b)[\w-]{1,20}\s+){0,3}(?:notifications?|alerts?|pop-?ups?|prompts?|warnings?|messages?|icons?|tray|telemetry)\b/i;
const SIDE_WINDOW = 80;

const FENCE = /^(?:```|~~~)/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const BLOCK_START = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/;
const SENTENCE_END = /(?<=[.!?])\s+|(?<=[。！？])/;
const MIN_SENTENCE_CHARS = 4;

function continues(last) {
  return last === '|' || last === '`' || last === '\\';
}

// 명령 단위: 줄 끝 파이프·백틱·역슬래시 또는 파이프로 시작하는 줄을 앞 명령에 잇는다. 코드블록 밖 Markdown 표는 건너뛴다.
// 문장 단위: 빈 줄·코드펜스·목록·제목에서 문단을 끊고, 문단 안 줄바꿈은 공백으로 이은 뒤 문장으로 나눈다.
// blocks[i]는 commands[i]가 속한 구역 번호로, 코드펜스를 지날 때마다 바뀐다.
// 이어지는 줄은 조각 배열로 모았다가 끝에서 한 번만 합친다. 줄마다 합친 문자열을 다시 훑으면 줄 수의 제곱이 된다.
function lineUnits(text) {
  const commands = [];
  const blocks = [];
  const sentences = [];
  let pending = null;
  let pendingLast = '';
  let paragraph = [];
  let inFence = false;
  let inTable = false;
  let previousCommandLine = false;
  let block = 0;
  const popCommand = () => {
    blocks.pop();
    return commands.pop();
  };
  const flushParagraph = () => {
    if (paragraph.length) for (const sentence of paragraph.join(' ').split(SENTENCE_END)) sentences.push(sentence);
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      inTable = false;
      block++;
      flushParagraph();
      continue;
    }
    if (line === '' || BLOCK_START.test(line)) flushParagraph();
    if (line !== '') paragraph.push(line);

    if (!inFence) {
      // 표는 빈 줄 또는 파이프가 없는 줄(제목·목록·문단)에서 끝난다.
      if (line === '' || !line.includes('|')) inTable = false;
      // 구분 행에 파이프가 있어야 표다. `---`만 있는 줄은 수평선이다.
      if (line.includes('|') && TABLE_SEPARATOR.test(line)) {
        if (previousCommandLine && pending === null) popCommand();
        inTable = true;
      }
      if (inTable || (line.startsWith('|') && line.endsWith('|') && line.length > 1)) {
        previousCommandLine = false;
        continue;
      }
    }
    if (pending !== null) {
      // 백틱·역슬래시 줄바꿈은 그 문자를 떼고 바로 잇는다.
      if (pendingLast === '`' || pendingLast === '\\') pending.push(pending.pop().slice(0, -1), line);
      else pending.push(' ', line);
    } else if (line.startsWith('|') && commands.length) {
      pending = popCommand();
      pending.push(' ', line);
    } else {
      pending = [line];
    }
    pendingLast = line === '' ? '' : line[line.length - 1];
    previousCommandLine = true;
    if (continues(pendingLast)) continue;
    commands.push(pending);
    blocks.push(block);
    pending = null;
  }
  if (pending !== null) {
    if (pendingLast === '`' || pendingLast === '\\') pending.push(pending.pop().slice(0, -1));
    commands.push(pending);
    blocks.push(block);
  }
  flushParagraph();
  return { commands: commands.map((parts) => withoutInert(parts.join(''))), blocks, sentences };
}

function isRemoteExec(unit) {
  if (INLINE_IEX.test(unit) && REMOTE_TARGET.test(unit)) return true;
  const substitution = SUBST_SHELL.exec(unit);
  if (substitution && !NO_EXEC_INLINE.test(substitution[0]) && REMOTE_TARGET.test(substitution[1])) return true;
  if (MSHTA.test(unit)) return true;
  const parts = unit.split('|');
  for (let i = 1; i < parts.length; i++) {
    const left = parts[i - 1];
    if (!FETCH.test(left) || !REMOTE_TARGET.test(left)) continue;
    if (RUN_POWERSHELL.test(parts[i]) || (RUN_SHELL.test(parts[i]) && shellReadsStdin(parts[i]))) return true;
  }
  return false;
}

// 원격에서 받아 만든 scriptblock을 호출하는 경우만 실행이다. 변수에 담았으면 같은 줄 또는 같은 코드블록의 다음 3줄에서 그 변수를 호출해야 한다.
function scriptblockRuns(commands, blocks, index) {
  const unit = commands[index];
  if (!SUBST_POWERSHELL.test(unit) || !REMOTE_TARGET.test(unit)) return null;
  const name = SCRIPTBLOCK_ASSIGNED.exec(unit)?.[1];
  if (!name) return SCRIPTBLOCK_DIRECT.test(unit) ? unit : null;
  const invoked = new RegExp(String.raw`(?:^|[;\s(])[&.]\s*\$${name}(?![\w.])|\$${name}\.invoke|\b(?:icm|invoke-command)\b[^\n]{0,80}?\$${name}(?!\w)`, 'i');
  if (invoked.test(unit)) return unit;
  for (let next = index + 1; next <= index + RUN_WINDOW && next < commands.length; next++) {
    if (blocks[next] !== blocks[index]) break;
    if (invoked.test(commands[next])) return `${unit} ; ${commands[next]}`;
  }
  return null;
}

// 경로를 뗀 파일 이름. Windows 경로는 대소문자를 구분하지 않으므로 소문자로 비교한다.
function baseName(value) {
  const name = value.replace(/^[`"'(]+|[`"');,]+$/g, '').split(/[\\/]/).pop().toLowerCase();
  return /^[\w.+-]{1,100}$/.test(name) && /[a-z0-9]/.test(name) && name !== 'null' ? name : null;
}

// 원격 주소를 파일로 저장하는 구간이면 저장되는 파일 이름을 돌려준다.
function savedFile(fullSegment) {
  const segment = fullSegment.slice(0, MAX_SEGMENT_CHARS);
  const tool = SAVE_TOOL.exec(segment)?.[1].toLowerCase();
  if (!tool || !REMOTE_TARGET.test(segment)) return null;
  // 내려받기 도구가 실제로 실행되는 자리(맨 앞 또는 실행기 바로 뒤)에 있어야 한다. `cat curl -o …`처럼 다른 명령의 인자면 저장이 아니다.
  // DownloadFile은 메서드 호출이라 자리를 정할 수 없어, 읽기 명령의 인자인 경우만 뺀다.
  const invoked = (invokedToken(segment) ?? '').split(/\s/, 1)[0].split(/[\\/]/).pop();
  if (tool === 'downloadfile' ? READER.test(invoked) : !SAVE_AT_START.test(invoked)) return null;
  const pattern = OUT_FILE[tool] ?? OUT_FILE.powershell;
  const named = pattern.exec(segment) ?? (tool === 'downloadfile' ? null : REDIRECT.exec(segment));
  if (named) {
    // 따옴표 안에 공백이 든 이름("my script.sh")은 첫 낱말만 잡히므로 추적하지 않는다.
    const opened = /["']$/.test(named[0].slice(0, named[0].length - named[1].length));
    if (opened && /\s/.test(segment[named.index + named[0].length] ?? '')) return null;
    return baseName(named[1]);
  }
  if (tool === 'wget' || (tool === 'curl' && REMOTE_NAME.test(segment))) {
    const fromUrl = URL_NAME.exec(segment);
    return fromUrl ? baseName(fromUrl[1]) : null;
  }
  return null;
}

// 따옴표로 묶인 부분은 공백이 있어도 한 토큰으로 본다.
function commandTokens(segment) {
  const tokens = [];
  for (const match of segment.slice(0, MAX_SEGMENT_CHARS).matchAll(TOKEN)) {
    tokens.push(match[0].replace(/^[`"'(]+|[`"')]+$/g, ''));
    if (tokens.length === RUN_TOKENS) break;
  }
  return tokens;
}

// 따옴표 밖의 구분자에서만 나눈다. pipes가 참이면 `|`, 아니면 문 구분자(`;`, `&&`, `||`, 공백으로 둘러싼 `&`).
// 낱말 가운데의 작은따옴표(don't)는 따옴표로 보지 않는다. 따옴표가 닫히지 않으면 따옴표를 무시하고 나눈다.
function splitTopLevel(text, pipes, ignoreQuotes = false) {
  const pieces = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (!ignoreQuotes && (ch === '"' || (ch === "'" && (i === 0 || /[\s=(]/.test(text[i - 1]))))) {
      quote = ch;
      continue;
    }
    let width = 0;
    if (pipes) {
      if (ch === '|' && text[i + 1] !== '|' && text[i - 1] !== '|') width = 1;
    } else if (ch === ';') width = 1;
    else if ((ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) width = 2;
    else if (ch === '&' && /\s/.test(text[i - 1] ?? '') && /\s/.test(text[i + 1] ?? '')) width = 1;
    if (!width) continue;
    pieces.push(text.slice(start, i));
    start = i + width;
    i += width - 1;
  }
  if (quote) return splitTopLevel(text, pipes, true);
  pieces.push(text.slice(start));
  return pieces;
}

// 명령 묶음을 따옴표 밖의 `;`·`&&`·`||`·`|`·공백으로 둘러싼 `&`(cmd.exe)에서 나눈 구간들.
// 실행기에 넘긴 명령 문자열(`bash -c "…"`)은 따옴표 안을 한 번 더 나눠 그 구간들로 바꾼다.
function commandSegments(unit, nested = false) {
  return splitTopLevel(unit, false).flatMap((statement) => splitTopLevel(statement, true)).flatMap((segment) => {
    const inner = nested ? null : INNER_COMMAND.exec(segment);
    return inner ? commandSegments(inner[2], true) : [segment];
  });
}

// 실행하지 않는 말(echo, true 등)로 시작하는 문은 뺀다. 그 말이 파이프의 첫 단계면 그 단계만 뺀다(`echo y | bash a.sh`의 뒤는 실행이다).
// 출력용으로 적힌 명령을 실행·저장으로 읽지 않기 위함이다.
function withoutInert(unit) {
  if (!INERT_HINT.test(unit)) return unit;
  const kept = [];
  for (const statement of splitTopLevel(unit, false)) {
    const stages = splitTopLevel(statement, true);
    const tokens = commandTokens(stages[0]);
    if (INERT.test(tokens[commandStart(tokens)] ?? '')) stages.shift();
    if (stages.length) kept.push(stages.join(' | '));
  }
  return kept.join(' ; ');
}

// 파이프 오른쪽 셸이 받은 내용을 실행하는지: 실행하지 않는 옵션(-n)이나 -c 명령문, 이름 붙은 스크립트 인자(-s 없이)가 있으면 표준 입력은 실행되지 않는다.
function shellReadsStdin(part) {
  const tokens = commandTokens(part);
  for (let at = commandStart(tokens) + 1; at < tokens.length; at++) {
    if (NO_EXEC_FLAG.test(tokens[at]) || /^-[a-z]*c$/i.test(tokens[at])) return false;
    if (READS_STDIN.test(tokens[at])) return true;
    if (tokens[at].startsWith('-')) continue;
    return !SCRIPT_ARGUMENT.test(tokens[at]);
  }
  return true;
}

// 문서에 흔한 프롬프트 표시(`$`, `>`, `PS C:\>`)와 감싸는 말(sudo -u root, env A=1)을 건너뛴 첫 명령 위치.
function commandStart(tokens) {
  let at = 0;
  if (PROMPT.test(tokens[0] ?? '')) at = /^PS$/i.test(tokens[0]) && tokens[1]?.endsWith('>') ? 2 : 1;
  while (WRAPPER.test((tokens[at] ?? '').split('/').pop())) {
    at++;
    while (at < tokens.length && (tokens[at].startsWith('-') || ENV_ASSIGNMENT.test(tokens[at]))) {
      at += WRAPPER_FLAG_WITH_VALUE.test(tokens[at]) ? 2 : 1;
    }
  }
  return at;
}

// 경로가 붙은 실행기(`/bin/bash`, `C:\Windows\System32\cmd.exe`)도 이름으로 알아본다.
function isRunner(token) {
  if (token === undefined) return false;
  return RUNNER.test(token) || RUNNER.test(token.split(/[\\/]/).pop());
}

// 구간이 실제로 실행하는 것: 맨 앞 실행기(겹치면 3단계까지)와 그 옵션을 건너뛴 첫 토큰. 실행기가 없으면 맨 앞 토큰이다.
// 인자가 데이터인 호출(`python -m json.tool x.json`)과 실행하지 않는 옵션(`bash -n x.sh`)은 null.
function invokedToken(segment) {
  const tokens = commandTokens(segment);
  let at = commandStart(tokens);
  for (let depth = 0; depth < MAX_RUNNER_DEPTH && isRunner(tokens[at]); depth++) {
    const python = /python3?$/i.test(tokens[at]);
    at++;
    while (at < tokens.length && (tokens[at] === '' || RUN_FLAG.test(tokens[at]))) {
      if (NO_EXEC_FLAG.test(tokens[at]) || (python && PYTHON_INLINE.test(tokens[at]))) return null;
      at += FLAG_WITH_VALUE.test(tokens[at]) ? 2 : 1;
    }
  }
  return tokens[at] ?? null;
}

// 구간이 실행하는 파일 이름 후보. 실행기가 맨 앞이 아니면(`echo bash x.sh`) 그 뒤 인자는 실행으로 보지 않는다.
function ranFiles(segment) {
  const name = baseName(invokedToken(segment) ?? '');
  return name ? [name] : [];
}

function savedThenRun(commands, blocks, index) {
  if (!SAVE_TOOL.test(commands[index])) return null;
  // 구간을 앞에서부터 한 번만 훑는다: 지금까지 저장한 이름을 기억해 두고, 뒤 구간이 그 이름을 실행하는지 본다.
  const names = [];
  for (const segment of commandSegments(commands[index])) {
    if (names.length && ranFiles(segment).some((name) => names.includes(name))) return commands[index];
    const name = savedFile(segment);
    if (!name) continue;
    names.push(name);
    if (names.length > MAX_SAVED_NAMES) names.shift();
  }
  if (!names.length) return null;
  for (let next = index + 1; next <= index + RUN_WINDOW && next < commands.length; next++) {
    if (blocks[next] !== blocks[index]) break;
    const ran = commandSegments(commands[next]).flatMap(ranFiles);
    if (ran.some((name) => names.includes(name))) return `${commands[index]} ; ${commands[next]}`;
  }
  return null;
}

function findExec(commands, blocks) {
  for (let i = 0; i < commands.length; i++) {
    if (isRemoteExec(commands[i])) return commands[i];
    const chained = scriptblockRuns(commands, blocks, i) ?? savedThenRun(commands, blocks, i);
    if (chained) return chained;
  }
  return null;
}

function decodeEncoded(commands) {
  const decoded = [];
  let attempts = 0;
  for (const command of commands) {
    if (!command.includes(' -')) continue;
    for (const match of command.matchAll(ENCODED)) {
      // 풀리지 않는 인자도 횟수에 넣는다. 그렇지 않으면 쓰레기 인자를 앞세워 상한을 넘길 수 있다.
      if (++attempts > MAX_DECODES) return decoded;
      if (NO_EXEC_INLINE.test(match[0])) continue;
      const token = match[1].slice(0, MAX_ENCODED_CHARS);
      const text = Buffer.from(token.slice(0, token.length - (token.length % 4)), 'base64').toString('utf16le');
      const readable = text.replace(/[^\t\n\r\x20-\x7e\u00a1-\ufffc]/g, '').length;
      if (text.length >= 8 && readable >= text.length * 0.9) decoded.push(text);
    }
  }
  return decoded;
}

function isCodeless(meta) {
  if (!meta || (meta.language != null && meta.language !== '')) return false;
  // 검색 응답의 숫자 값만 인정한다. 형식이 다르면 조건부 규칙을 끄는 쪽(덜 숨김)으로 떨어진다.
  if (typeof meta.forks !== 'number' || typeof meta.size !== 'number') return false;
  return meta.forks === 0 && meta.size >= 0 && meta.size <= CODELESS_MAX_SIZE_KB;
}

function isNegated(sentence, index) {
  if (NEGATION_V1.test(sentence.slice(Math.max(0, index - 30), index).replace(/[*_~`]/g, ''))) return true;
  const before = sentence.slice(Math.max(0, index - 100), index).replace(/[*_~`]/g, '');
  if (NOT_INSTRUCTION.test(before.slice(-30))) return true;
  // "Never, ever forget to disable …"는 금지가 아니라 꼭 하라는 지시다.
  return !DOUBLE_NEGATIVE.test(before) && (NEGATION_MORE.test(before) || NEGATION_ASIDE.test(before));
}

function isProtectionOff(sentence, generic) {
  if (sentence.length < MIN_SENTENCE_CHARS || EXCLUSION.test(sentence)) return false;
  for (const pattern of PROTECTION_OFF) {
    for (const match of sentence.matchAll(pattern)) {
      if (isNegated(sentence, match.index)) continue;
      if (SIDE_TARGET.test(sentence.slice(match.index + match[0].length, match.index + match[0].length + SIDE_WINDOW))) continue;
      return true;
    }
  }
  if (!generic || !GENERIC_HINT.test(sentence) || GENERIC_NEGATED.test(sentence) || GENERIC_SIDE.test(sentence)) return false;
  for (const match of sentence.matchAll(GENERIC_OFF)) {
    if (match.index <= GENERIC_LEAD_MAX && GENERIC_SENTENCE_START.test(sentence.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * @param {string | null} text
 * @param {{ language?: string | null, forks?: number | null, size?: number | null }} [meta] 검색 응답 메타. 없으면 메타 조건부 규칙을 쓰지 않는다.
 */
export function classifyReadme(text, meta) {
  if (typeof text !== 'string' || text === '') return { verdict: 'clean', evidence: null };
  let exec = null;
  let off = null;
  const generic = isCodeless(meta);
  const readme = lineUnits(text);
  for (const unit of [readme, ...decodeEncoded(readme.commands).map(lineUnits)]) {
    exec ??= findExec(unit.commands, unit.blocks);
    off ??= unit.sentences.find((sentence) => isProtectionOff(sentence, generic)) ?? null;
    if (exec && off) return { verdict: 'malicious', evidence: `${exec} || ${off}`.slice(0, MAX_EVIDENCE) };
  }
  return { verdict: 'clean', evidence: null };
}

export async function fetchReadme(octokit, owner, name) {
  try {
    const { data } = await octokit.rest.repos.getReadme({ owner, repo: name, mediaType: { format: 'raw' } });
    const text = typeof data === 'string' ? data : Buffer.from(data ?? '').toString('utf8');
    return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) : text;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function timeOf(value) {
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function needsScan(previous, pushedAt) {
  if (!previous) return true;
  if (previous.verdict === 'unknown') return true;
  if (Number(previous.rule_version) !== RULE_VERSION) return true;
  return timeOf(previous.repo_pushed_at) !== timeOf(pushedAt);
}

function isRateLimited(error) {
  if (error?.status === 429) return true;
  if (error?.status !== 403) return false;
  const headers = error.response?.headers ?? {};
  return Boolean(headers['retry-after']) || headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(String(error.message));
}

// GitHub REST 2차 한도(분당 약 900회)를 넘지 않도록 요청 시작 간격을 둔다. 한도에 걸리면 남은 검사는 다음 수집으로 넘긴다.
export function createReadmeScanner({
  model, fetchReadme: fetch = fetchReadme, log = console, now = () => new Date(), concurrency = 4,
  minIntervalMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now,
}) {
  async function scanRepos(octokit, repos) {
    const result = { scanned: 0, malicious: 0, unknown: 0, skipped: 0 };
    let nextStart = 0;
    let halted = false;
    const pace = async () => {
      const at = Math.max(clock(), nextStart);
      nextStart = at + minIntervalMs;
      const wait = at - clock();
      if (wait > 0) await sleep(wait);
    };
    const unique = new Map();
    for (const repo of repos) {
      const id = Number(repo?.github_id);
      if (Number.isSafeInteger(id) && id > 0 && !unique.has(id)) unique.set(id, repo);
    }
    if (!unique.size) return result;
    const existing = await model.findVerdicts([...unique.keys()]);
    const queue = [];
    for (const [id, repo] of unique) {
      if (needsScan(existing.get(id), repo.pushed_at)) queue.push([id, repo]);
      else result.skipped++;
    }

    async function scanOne([id, repo]) {
      if (!halted) await pace();
      if (halted) {
        result.skipped++;
        return;
      }
      let text;
      try {
        text = await fetch(octokit, repo.owner, repo.name);
      } catch (error) {
        // 한도에 걸린 요청도 조회 실패라 아래 R2.2 처리를 따르고, 아직 요청하지 않은 저장소만 판정 없이 다음 수집으로 넘긴다.
        if (isRateLimited(error)) {
          if (!halted) log.warn(`[readme-scan] rate limited status=${error.status} — 남은 검사는 다음 수집에서 재시도`);
          halted = true;
        } else {
          log.warn(`[readme-scan] github_id=${id} status=${error?.status ?? 'error'}`);
        }
        // 기존 판정은 성공한 재검사로만 바뀐다(D-008). push 시각을 갱신하지 않아 다음 수집에서 다시 시도한다.
        if (!existing.has(id)) {
          await model.upsertVerdict({
            github_id: id, verdict: 'unknown', rule_version: RULE_VERSION, evidence: null, repo_pushed_at: null, scanned_at: new Date(now()),
          });
          result.unknown++;
        }
        return;
      }
      const { verdict, evidence } = classifyReadme(text, repo);
      await model.upsertVerdict({
        github_id: id, verdict, rule_version: RULE_VERSION, evidence,
        repo_pushed_at: repo.pushed_at ? new Date(repo.pushed_at) : null, scanned_at: new Date(now()),
      });
      result.scanned++;
      if (verdict === 'malicious') result.malicious++;
    }

    // 한 저장소의 저장 실패가 다른 판정을 끊거나 순위 기록을 앞질러 진행시키지 않도록 저장소 단위로 격리한다.
    async function scanSafely(entry) {
      try {
        await scanOne(entry);
      } catch (error) {
        log.warn(`[readme-scan] github_id=${entry[0]} store=${error?.code ?? error?.name ?? 'error'}`);
      }
    }

    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) await scanSafely(queue[next++]);
    });
    await Promise.all(workers);
    return result;
  }

  return { scanRepos };
}
