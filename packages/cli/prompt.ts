import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

const MAX_LENGTH = 4096;
const MAX_ATTEMPTS = 3;

export class NonInteractiveInputError extends Error {}

// DI-friendly: accepts streams so tests can inject fakes.
export async function promptSecretValue(
  label: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): Promise<string> {
  if (!stdin.isTTY) {
    throw new NonInteractiveInputError("Secret input requires an interactive terminal.");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    stdout.write(`Enter value for ${label} (input is hidden): `);
    const raw = await readHiddenLine(stdin, stdout);
    const value = raw;

    if (value.length === 0 || /^\s*$/.test(value)) {
      stdout.write("Value cannot be empty.\n");
      continue;
    }
    if (value.length > MAX_LENGTH || /[\r\n]/.test(value)) {
      stdout.write(`Value exceeds ${MAX_LENGTH} characters.\n`);
      continue;
    }

    return value;
  }

  throw new Error("Too many empty or invalid attempts.");
}

export async function confirm(
  question: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): Promise<boolean> {
  if (!stdin.isTTY) {
    return false;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// The Lemon purchase key is entered by a human and sent only to the fixed
// license-exchange service. It is hidden to avoid screen capture and shoulder
// surfing, even though it is lower sensitivity than an API credential.
export async function promptPurchaseLicenseKey(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): Promise<string> {
  if (!stdin.isTTY) {
    throw new NonInteractiveInputError("Purchase license key input requires an interactive terminal.");
  }
  stdout.write("Enter your purchase license key (input is hidden): ");
  const value = (await readHiddenLine(stdin, stdout)).trim();
  if (value.length === 0 || value.length > MAX_LENGTH || /[\r\n]/.test(value)) {
    throw new Error("Invalid purchase license key input.");
  }
  return value;
}

function readHiddenLine(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolvePromise) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    let buffer = "";

    const cleanup = (): void => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode?.(Boolean(wasRaw));
      stdin.pause();
    };

    const onKeypress = (
      chunk: string,
      key: { name?: string; ctrl?: boolean } | undefined
    ): void => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        stdout.write("\n");
        process.exit(1);
      }

      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        stdout.write("\n");
        resolvePromise(buffer);
        return;
      }

      if (key?.name === "backspace") {
        buffer = buffer.slice(0, -1);
        return;
      }

      if (chunk && !key?.ctrl) {
        buffer += chunk;
      }
    };

    stdin.on("keypress", onKeypress);
  });
}
