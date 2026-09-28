import { CliError } from '../protocol/errors.ts';
import { CLI_NAME } from '../core/paths.ts';

export interface CommandSpec {
  /** One-line synopsis without the program name, e.g. `status <ref> [--full]`. */
  usage: string;
  summary: string;
  /** Options that take a value. */
  values?: string[];
  /** Boolean options. `--pretty` and `--help` are always accepted. */
  flags?: string[];
  /** Alternative option names (without dashes) mapped to their canonical name. */
  aliases?: Record<string, string>;
  /** Minimum and maximum positional arguments. */
  args?: [number, number];
  hidden?: boolean;
}

export type Opts = Record<string, string | true | undefined>;
export interface Parsed { opts: Opts; args: string[] }

const GLOBAL_FLAGS = ['pretty', 'help'];

export const usageError = (message: string, spec?: CommandSpec) =>
  new CliError('USAGE', message, spec ? `Usage: ${CLI_NAME} ${spec.usage}` : `Run ${CLI_NAME} --help`);

/** Strict parser: unknown options, missing values, repeats and extra positionals are usage errors. */
export function parseArgs(argv: string[], spec: CommandSpec): Parsed {
  const opts: Opts = {}, args: string[] = [];
  const values = new Set(spec.values ?? []), flags = new Set([...(spec.flags ?? []), ...GLOBAL_FLAGS]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h') { opts.help = true; continue; }
    if (!token.startsWith('--') || token === '--') { args.push(token); continue; }
    const eq = token.indexOf('=');
    const given = eq > 2 ? token.slice(2, eq) : token.slice(2);
    const name = spec.aliases?.[given] ?? given;
    let value: string | undefined = eq > 2 ? token.slice(eq + 1) : undefined;
    if (flags.has(name)) {
      if (value !== undefined) throw usageError(`--${given} takes no value.`, spec);
      opts[name] = true; continue;
    }
    if (!values.has(name)) throw usageError(`Unknown option --${given}.`, spec);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw usageError(`--${given} needs a value.`, spec);
    }
    if (opts[name] !== undefined) throw usageError(`--${name} was given more than once.`, spec);
    opts[name] = value;
  }
  const [min, max] = spec.args ?? [0, 0];
  if (!opts.help && args.length < min) throw usageError('Missing argument.', spec);
  if (!opts.help && args.length > max) throw usageError(`Unexpected argument: ${args[max]}.`, spec);
  return { opts, args };
}

export const str = (opts: Opts, name: string) => typeof opts[name] === 'string' ? opts[name] as string : undefined;

export function int(opts: Opts, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(opts, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new CliError('USAGE', `--${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export function oneOf<T extends string>(opts: Opts, name: string, allowed: readonly T[]): T | undefined {
  const raw = str(opts, name);
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) throw new CliError('USAGE', `--${name} must be one of: ${allowed.join(', ')}.`);
  return raw as T;
}
