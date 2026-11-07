// Minimal stand-in for InsomniaZAuto.exe used by the AutoBridge unit tests.
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

let buffer = '';

function handle(line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, cmd, args = {} } = request;
  switch (cmd) {
    case 'hello':
      send({ id, ok: true, data: { version: 'stub', pid: process.pid, ocr: true } });
      break;
    case 'echo':
      send({ id, ok: true, data: { echo: args } });
      break;
    case 'fail':
      send({
        id,
        ok: false,
        error: {
          code: args.code || 'UNEXPECTED_EXCEPTION',
          message: 'stub failure',
          retryable: args.retryable !== false,
        },
      });
      break;
    case 'sleep':
      setTimeout(() => send({ id, ok: true, data: { slept: args.ms } }), args.ms);
      break;
    case 'noise':
      process.stdout.write('not json at all\n');
      send({ id, ok: true, data: { noisy: true } });
      break;
    case 'die':
      process.exit(0);
      break;
    default:
      send({ id, ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'unknown command', retryable: false } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(line);
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
