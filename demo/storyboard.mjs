// Turns the captured transcript into a timeline the scene renderer replays.
//
// Every terminal line here comes from build/transcript.json. This file decides
// *when* a recorded line appears, never *what* it says. The only text invented
// here is the on-screen commentary (cards and side notes), which is clearly
// separate from terminal output in the layout.

import { readFileSync } from "node:fs";
import { TRANSCRIPT_PATH, VIDEO } from "./config.mjs";

const TERMINAL = { cols: 94, rows: 24 };

// Reading speed knobs, in milliseconds.
const TYPE_MS_PER_CHAR = 38;
const PAUSE_AFTER_TYPING = 420;
const FAST_LINE = 26;
const NORMAL_LINE = 55;
const SLOW_LINE = 190;

export function buildTimeline(transcriptPath = TRANSCRIPT_PATH, locale = "en") {
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const byId = new Map(transcript.commands.map((command) => [command.id, command]));
  const command = (id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`transcript is missing the "${id}" command`);
    return found;
  };

  const events = [];
  const notes = [];
  const cards = [];
  let t = 0;

  const at = (ms) => {
    t = ms;
  };
  const wait = (ms) => {
    t += ms;
  };

  // `caption` is the subtitle line for this beat. It defaults to the on-screen
  // title, which is already a complete short sentence.
  const note = (title, body, holdMs, caption) => {
    const start = t;
    notes.push({ start, end: start + holdMs, title, body, caption: caption ?? title });
    return start;
  };

  const clear = () => {
    events.push({ t, type: "clear" });
  };

  const typeCommand = (text) => {
    events.push({ t, type: "prompt", text, msPerChar: TYPE_MS_PER_CHAR });
    t += text.length * TYPE_MS_PER_CHAR + PAUSE_AFTER_TYPING;
    events.push({ t, type: "submit" });
    t += 260;
  };

  const emit = (lines, msPerLine) => {
    for (const line of lines) {
      events.push({ t, type: "line", text: line });
      t += msPerLine;
    }
  };

  // ---------------------------------------------------------------- intro
  cards.push({
    kind: "intro",
    start: 0,
    end: 7600,
    fade: 460,
    kicker: "API KEY CASE",
    lines: [
      { text: "Your AI coding agent reads your repo.", at: 300, tone: "soft" },
      { text: "Keep API keys out of\nyour AI coding sessions.", at: 2100, tone: "hero" }
    ],
    footer: { text: "A local-first CLI.  Windows · macOS · Linux.", at: 5000 }
  });
  at(7900);

  // ----------------------------------------------------------------- scan
  const scan = command("scan");
  clear();
  note(
    "1 — Scan before anything leaves your machine",
    [
      "It finds env files git is already tracking, the variable names your code needs, and tokens hardcoded in source.",
      "One command. No account, no upload."
    ],
    14200
  );
  typeCommand(scan.display);
  emit(scan.lines.slice(0, 19), FAST_LINE);
  emit(scan.lines.slice(19, 22), SLOW_LINE);
  wait(600);
  emit(scan.lines.slice(22, 31), FAST_LINE);
  emit(scan.lines.slice(31), 240);
  wait(2600);

  at(t);
  note(
    "It found a key — and still won't show it",
    [
      "Each finding is reported as a file, a line and a kind.",
      "The value itself is printed as ***REDACTED***, so the report is safe to paste into an agent."
    ],
    5200
  );
  wait(5200);

  // ----------------------------------------------------------------- save
  const save = command("save");
  clear();
  note(
    "2 — Save it where the agent can't read it",
    [
      "You type the value into a hidden prompt. It goes straight into the OS secret store — Keychain, Credential Manager, or libsecret.",
      "There is no api-key-case command that prints it back."
    ],
    11200
  );
  typeCommand(save.display);
  emit([save.lines[0]], NORMAL_LINE);
  events.push({ t, type: "hiddenInput", durationMs: 2600 });
  wait(2900);
  emit([save.lines[1]], NORMAL_LINE);
  wait(2200);

  at(t);
  note(
    "No value ever reaches argv or a pipe",
    [
      "Passing the value as an argument is rejected, and so is piped input.",
      "Both would survive in shell history or process logs."
    ],
    4600
  );
  wait(4600);

  // ---------------------------------------------------------------- check
  const check = command("check");
  clear();
  note(
    "3 — Check status, never contents",
    [
      "check answers exactly one question per secret: registered, or missing.",
      "Safe to run with an agent watching your terminal."
    ],
    8000
  );
  typeCommand(check.display);
  emit(check.lines, 320);
  wait(4200);

  // -------------------------------------------------------------- targets
  const targets = command("targets");
  clear();
  note(
    "4 — Pro: put it where it has to run",
    [
      "Cloudflare, Vercel and GitHub, each through that platform's own CLI — wrangler, vercel, gh.",
      "targets shows what is detected here and whether each CLI is ready."
    ],
    9200
  );
  typeCommand(targets.display);
  emit(targets.lines, 380);
  wait(4200);

  // --------------------------------------------------------------- deploy
  const dryRun = command("deployDryRun");
  clear();
  note(
    "5 — Dry run first",
    [
      "See the exact command that would run, before the stored value is read or anything is sent."
    ],
    9600,
    "Dry run first: see the exact command."
  );
  typeCommand(dryRun.display);
  emit(dryRun.lines, 300);
  wait(3400);

  at(t);
  notes.push({
    start: t,
    end: t + 6200,
    title: "How the value travels",
    body: [],
    flow: ["OS secret store", "api-key-case", "wrangler stdin", "Cloudflare"],
    footnote: "Never argv. Never a file. Never a log line.",
    caption: "OS secret store to the platform CLI's stdin."
  });
  wait(6600);

  // --------------------------------------------- production confirmation
  const confirm = command("deployConfirm");
  clear();
  note(
    "6 — Production always asks",
    [
      "The same command, without --dry-run. Typing the whole word 'yes' is the only way through.",
      "There is no flag that skips it."
    ],
    12000
  );
  typeCommand(confirm.display);
  emit(confirm.lines.slice(0, 6), FAST_LINE);
  wait(500);

  // "Type 'yes' to deploy to production: no" — the prompt is shown, then the
  // answer is typed onto the end of the same line, as it was recorded.
  const confirmLine = confirm.lines[6];
  const answer = "no";
  const question = confirmLine.slice(0, confirmLine.length - answer.length);
  events.push({ t, type: "line", text: question });
  t += 1500;
  events.push({ t, type: "appendTyping", text: answer, msPerChar: 190 });
  t += answer.length * 190 + 700;
  emit([confirm.lines[7]], NORMAL_LINE);
  wait(3200);

  const terminalEnd = t + 500;

  // ---------------------------------------------------------------- outro
  at(terminalEnd + 200);
  cards.push({
    kind: "outro",
    start: t,
    end: t + 10600,
    fade: 460,
    kicker: "API KEY CASE",
    tagline: "A local-first CLI that keeps API keys out of AI coding sessions.",
    free: {
      label: "Free, forever",
      items: ["scan", "save", "check", "list", "remove", "targets", "MCP server"]
    },
    pro: {
      label: "Pro",
      items: ["deploy → Cloudflare", "deploy → Vercel", "deploy → GitHub"]
    },
    price: { title: "API Key Case Pro", amount: "¥2,980", terms: "One-time purchase · no subscription" },
    url: "apikeycase.melavern.com",
    footer: "Source available under Elastic-2.0 · Node 20+ · Windows, macOS, Linux"
  });
  const durationMs = t + 10600;

  const timeline = {
    meta: {
      width: VIDEO.width,
      height: VIDEO.height,
      fps: VIDEO.fps,
      durationMs,
      locale: "en",
      cliVersion: transcript.cli.version,
      recordedAt: transcript.recordedAt
    },
    chrome: {
      footer: "Recorded from a real terminal session. No secret value is shown at any point."
    },
    terminal: {
      start: 7600,
      end: terminalEnd,
      fade: 320,
      title: "demo-checkout — api-key-case",
      cols: TERMINAL.cols,
      rows: TERMINAL.rows,
      prompt: "$ ",
      events
    },
    notes,
    cards
  };

  return locale === "ja" ? localizeJapanese(timeline) : timeline;
}

function localizeJapanese(timeline) {
  const localized = structuredClone(timeline);
  localized.meta.locale = "ja";
  localized.chrome.footer = "実際のターミナル操作を収録。秘密値は一度も表示していません。";

  const intro = localized.cards.find((card) => card.kind === "intro");
  intro.lines = [
    { text: "AIコーディングエージェントは、\nあなたのリポジトリを読みます。", at: 300, tone: "soft" },
    { text: "APIキーを、\nAIに見せない。", at: 2100, tone: "hero" }
  ];
  intro.footer.text = "ローカルファーストCLI · Windows · macOS · Linux";

  const copy = [
    {
      title: "1 — 外へ出る前にスキャン",
      body: [
        "Git追跡中のenv、必要な変数名、ソースへ直書きされたトークンを検出します。",
        "アカウント登録もアップロードも不要です。"
      ],
      caption: "外へ出る前に、ローカルでスキャン。"
    },
    {
      title: "キーを見つけても、値は見せない",
      body: [
        "場所・行番号・種類だけを報告します。",
        "値は ***REDACTED*** に置き換え、そのままAIへ渡せます。"
      ],
      caption: "キーを見つけても、値は表示しません。"
    },
    {
      title: "2 — AIが読めない場所へ保存",
      body: [
        "非表示入力した値を、OSのシークレットストアへ直接保存します。",
        "保存値を表示するコマンドはありません。"
      ],
      caption: "AIが読めないOSシークレットストアへ保存。"
    },
    {
      title: "値を引数やパイプへ流さない",
      body: [
        "引数とパイプ入力を拒否します。",
        "シェル履歴やプロセスログへ残る経路を作りません。"
      ],
      caption: "引数にもパイプにも値を渡しません。"
    },
    {
      title: "3 — 中身ではなく状態だけ確認",
      body: [
        "checkが返すのは、登録済みか未登録かだけ。",
        "AIが見ていても安全に実行できます。"
      ],
      caption: "確認できるのは登録済みか未登録かだけ。"
    },
    {
      title: "4 — Pro：必要な場所へ配置",
      body: [
        "Cloudflare・Vercel・GitHubの公式CLIを利用します。",
        "targetsで利用可能な配置先を確認できます。"
      ],
      caption: "Proなら3社の公式CLIへ安全に配置。"
    },
    {
      title: "5 — まずdry-run",
      body: [
        "値を読む前、送信前に、実行予定のコマンドを確認できます。"
      ],
      caption: "最初にdry-runで実行内容を確認。"
    },
    {
      title: "値が通る経路",
      body: [],
      flow: ["OSシークレットストア", "api-key-case", "wranglerの標準入力", "Cloudflare"],
      footnote: "引数にしない。ファイルに書かない。ログに残さない。",
      caption: "OSシークレットストアから公式CLIの標準入力へ。"
    },
    {
      title: "6 — productionは必ず確認",
      body: [
        "yesを最後まで入力したときだけ実行します。",
        "確認を省略するフラグはありません。"
      ],
      caption: "productionへの配置は必ず確認します。"
    }
  ];

  if (localized.notes.length !== copy.length) {
    throw new Error(`Japanese storyboard copy is out of sync: expected ${copy.length} notes, found ${localized.notes.length}`);
  }
  localized.notes = localized.notes.map((note, index) => ({ ...note, ...copy[index] }));

  const outro = localized.cards.find((card) => card.kind === "outro");
  outro.tagline = "APIキーを、AIに見せずに扱うローカルファーストCLI。";
  outro.free.label = "Free（現行版）";
  outro.pro.label = "Pro";
  outro.price.terms = "買い切り · サブスクリプションではありません";
  outro.footer = "Elastic-2.0でソース公開 · Node 20+ · Windows / macOS / Linux";

  return localized;
}

// WebVTT for the <track> element on the site; SRT for editors and uploads.
export function toVtt(timeline) {
  const body = buildCues(timeline)
    .map((cue) => `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${wrap(cue.text, timeline.meta.locale)}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toSrt(timeline) {
  return `${buildCues(timeline)
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${wrap(cue.text, timeline.meta.locale)}\n`)
    .join("\n")}`;
}

// One short, complete cue per beat. Cues are clipped so they never overlap:
// two subtitles on screen at once is worse than none.
function buildCues(timeline) {
  const cues = [];

  for (const card of timeline.cards) {
    if (card.kind === "intro") {
      for (const line of card.lines) {
        cues.push({
          start: card.start + line.at,
          end: card.end,
          text: timeline.meta.locale === "ja" ? line.text : line.text.replace(/\n/g, " ")
        });
      }
    }
    if (card.kind === "outro") {
      // Held longer than the elements fade in: a subtitle needs reading time,
      // not the animation's timing.
      cues.push({ start: card.start, end: card.end, text: card.tagline });
      cues.push({
        start: card.start + 3200,
        end: card.end,
        text: timeline.meta.locale === "ja"
          ? `${card.price.title} — ${card.price.amount}、${card.price.terms}。`
          : `${card.price.title} — ${card.price.amount}, ${card.price.terms.toLowerCase()}.`
      });
      cues.push({ start: card.start + 6400, end: card.end, text: card.url });
    }
  }

  for (const note of timeline.notes) {
    cues.push({ start: note.start, end: note.end, text: note.caption ?? note.title });
  }

  cues.sort((a, b) => a.start - b.start);

  for (let index = 0; index < cues.length - 1; index += 1) {
    cues[index].end = Math.min(cues[index].end, cues[index + 1].start);
  }

  const tooLong = cues.filter((cue) => wrap(cue.text, timeline.meta.locale).split("\n").length > 2);
  if (tooLong.length > 0) {
    throw new Error(
      `subtitle cue does not fit in two lines: ${tooLong.map((cue) => JSON.stringify(cue.text)).join(", ")}`
    );
  }

  return cues.filter((cue) => cue.end - cue.start >= 1200);
}

function vttTime(ms) {
  return srtTime(ms).replace(",", ".");
}

function srtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const hours = String(Math.floor(total / 3_600_000)).padStart(2, "0");
  const minutes = String(Math.floor(total / 60_000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(total / 1000) % 60).padStart(2, "0");
  const millis = String(total % 1000).padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${millis}`;
}

// Never truncates: buildCues treats an over-long cue as an authoring error
// rather than silently cutting a sentence in half.
function wrap(text, locale = "en", width = 46) {
  if (locale === "ja") return wrapJapanese(text, 25);

  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
}

function wrapJapanese(text, width) {
  if (text.includes("\n")) {
    return text.split("\n").map((line) => wrapJapanese(line, width)).join("\n");
  }

  const characters = Array.from(text);
  if (characters.length <= width) return text;

  const lines = [];
  let remaining = characters;
  while (remaining.length > width) {
    const window = remaining.slice(0, width + 1);
    let breakAt = -1;
    for (let index = window.length - 1; index >= Math.floor(width * 0.65); index -= 1) {
      if (/[、。・：／ ]/.test(window[index])) {
        breakAt = index + 1;
        break;
      }
    }
    if (breakAt === -1) breakAt = width;
    lines.push(remaining.slice(0, breakAt).join("").trim());
    remaining = remaining.slice(breakAt);
  }
  if (remaining.length > 0) lines.push(remaining.join("").trim());
  return lines.join("\n");
}
