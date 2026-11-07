import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type {
  AiActivitySnapshot,
  AiStreamingLevel,
  LocalAiRuntime,
  NetworkAdapterInfo,
  RemoteAiHost,
  SoftStopKnowledgeBase,
} from '../../shared/soft-stop';
import {
  adapterMatchesPort,
  adapterMatchesProcess,
  pickModelFromPayload,
  runtimeIsIdle,
} from '../../shared/soft-stop';
import { AI_HOST_SUFFIXES } from './knowledge';
import type { Logger } from './logger';

export interface ProcessRow {
  name: string;
  pid: number;
}

export interface ListenRow {
  port: number;
  pid: number;
}

export interface DnsRow {
  name: string;
  address: string;
}

export interface ConnectionRow {
  address: string;
  port: number;
  pid: number;
}

export interface RawNetworkAdapter {
  name: string;
  description: string;
  up: boolean;
}

export interface NetworkSample {
  adapters: RawNetworkAdapter[];
  dns: DnsRow[];
  connections: ConnectionRow[];
  bytesIn: number;
  bytesOut: number;
  bytesIn2: number;
  bytesOut2: number;
  elapsedMs: number;
}

export interface LocalCandidate {
  adapterId: string;
  label: string;
  port: number | null;
  pid: number | null;
  processName: string | null;
  processMatched: boolean;
  base: string;
  discoverPath: string;
  modelPath?: string;
  fallbackPath?: string;
  fallbackModelPath?: string;
}

export interface DetectorOptions {
  knowledge: SoftStopKnowledgeBase;
  logger: Logger;
  cacheMs?: number;
  probeTimeoutMs?: number;
  commandTimeoutMs?: number;
  hostSuffixes?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  systemRoot?: string;
}

const DEFAULT_CACHE_MS = 12_000;
const PROBE_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_REMOTE_HOSTS = 12;

function systemExecutable(name: string, systemRoot?: string): string {
  const root = systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  return join(root, 'System32', name);
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function powershellExe(systemRoot?: string): string {
  const root = systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const NETWORK_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  '$adapters = @(Get-NetAdapter | ForEach-Object { [pscustomobject]@{ name = $_.Name; description = $_.InterfaceDescription; up = ($_.Status -eq "Up") } })',
  '$dns = @(Get-DnsClientCache | ForEach-Object { [pscustomobject]@{ entry = $_.Entry; data = $_.Data } } | Select-Object -First 600)',
  '$conns = @(Get-NetTCPConnection -State Established | Where-Object { $_.RemotePort -eq 443 -or $_.RemotePort -eq 80 } | ForEach-Object { [pscustomobject]@{ remote = $_.RemoteAddress; port = $_.RemotePort; pid = $_.OwningProcess } } | Select-Object -First 600)',
  '$in1 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum',
  '$out1 = (Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum',
  'Start-Sleep -Milliseconds 700',
  '$in2 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum',
  '$out2 = (Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum',
  '[pscustomobject]@{ adapters = $adapters; dns = $dns; connections = $conns; bytesIn = [double]$in1; bytesOut = [double]$out1; bytesIn2 = [double]$in2; bytesOut2 = [double]$out2; elapsedMs = 700 } | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

function runPowerShell(script: string, timeoutMs: number, systemRoot?: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runCommand(
    powershellExe(systemRoot),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    timeoutMs,
  );
}

export function parseTasklistCsv(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    const pid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid)) continue;
    rows.push({ name: match[1], pid });
  }
  return rows;
}

export function parseListeningRows(output: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const port = Number.parseInt(match[2], 10);
    const pid = Number.parseInt(match[3], 10);
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
    rows.push({ port, pid });
  }
  return rows;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseNetworkSample(output: string): NetworkSample {
  const decoded = JSON.parse(output) as unknown;
  const parsed = (Array.isArray(decoded) ? decoded[0] : decoded) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') throw new Error('unexpected network sample');
  const adapters: RawNetworkAdapter[] = [];
  for (const raw of asArray(parsed.adapters)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = textValue(item.name);
    if (!name) continue;
    adapters.push({
      name,
      description: textValue(item.description),
      up: item.up === true || item.status === 'Up',
    });
  }
  const dns: DnsRow[] = [];
  for (const raw of asArray(parsed.dns)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = textValue(item.entry);
    const address = textValue(item.data);
    if (name && address) dns.push({ name, address });
  }
  const connections: ConnectionRow[] = [];
  for (const raw of asArray(parsed.connections)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const address = textValue(item.remote);
    const port = asNumber(item.port);
    const pid = asNumber(item.pid);
    if (!address || !Number.isInteger(port) || !Number.isInteger(pid)) continue;
    connections.push({ address, port, pid });
  }
  return {
    adapters,
    dns,
    connections,
    bytesIn: asNumber(parsed.bytesIn),
    bytesOut: asNumber(parsed.bytesOut),
    bytesIn2: asNumber(parsed.bytesIn2),
    bytesOut2: asNumber(parsed.bytesOut2),
    elapsedMs: asNumber(parsed.elapsedMs) || 700,
  };
}

export function adapterTypeFor(name: string, description: string): NetworkAdapterInfo['type'] {
  const haystack = `${name} ${description}`.toLowerCase();
  if (/wi-?fi|wlan|wireless|802\.11/.test(haystack)) return 'wifi';
  if (/\b(?:wwan|mobile|cellular|lte|5g|4g|modem|broadband)\b/.test(haystack)) return 'wwan';
  if (/vethernet|hyper-v|virtualbox|vmware|virtual|tap-|vpn|loopback|bluetooth/.test(haystack)) {
    return 'other';
  }
  if (/ethernet|gbe|gigabit|realtek|i219|i225|i226/.test(haystack)) return 'ethernet';
  return 'other';
}

export function classifyNetworkAdapters(raw: RawNetworkAdapter[]): NetworkAdapterInfo[] {
  const result: NetworkAdapterInfo[] = [];
  const seen = new Set<string>();
  for (const adapter of raw) {
    const key = adapter.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: adapter.name,
      type: adapterTypeFor(adapter.name, adapter.description),
      up: adapter.up,
    });
    if (result.length >= 12) break;
  }
  return result;
}

export function throughputFromSample(sample: NetworkSample): number {
  const elapsed = Math.max(200, sample.elapsedMs) / 1000;
  const delta =
    sample.bytesIn2 - sample.bytesIn + (sample.bytesOut2 - sample.bytesOut);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta / elapsed);
}

function normalizeIp(value: string): string {
  let address = value.trim().toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.startsWith('::ffff:') && address.includes('.')) address = address.slice(7);
  return address;
}

export function hostMatchesSuffix(host: string, suffixes: readonly string[]): boolean {
  const needle = host.toLowerCase().replace(/\.$/, '');
  return suffixes.some((suffix) => {
    const candidate = suffix.toLowerCase();
    return needle === candidate || needle.endsWith(`.${candidate}`);
  });
}

export interface RemoteResult {
  hosts: RemoteAiHost[];
  connected: boolean;
}

export function detectRemoteHosts(
  dns: DnsRow[],
  connections: ConnectionRow[],
  suffixes: readonly string[] = AI_HOST_SUFFIXES,
): RemoteResult {
  const ipToHost = new Map<string, string>();
  for (const row of dns) {
    const host = row.name.toLowerCase().replace(/\.$/, '');
    if (!host || !hostMatchesSuffix(host, suffixes)) continue;
    const address = normalizeIp(row.address);
    if (!address) continue;
    ipToHost.set(address, host);
  }

  const merged = new Map<string, Set<string>>();
  for (const row of dns) {
    const host = row.name.toLowerCase().replace(/\.$/, '');
    if (!host || !hostMatchesSuffix(host, suffixes)) continue;
    if (!merged.has(host)) merged.set(host, new Set(['dns-cache']));
  }

  let connected = false;
  for (const connection of connections) {
    const address = normalizeIp(connection.address);
    const host = ipToHost.get(address);
    if (!host) continue;
    connected = true;
    const evidence = merged.get(host) ?? new Set<string>();
    evidence.add(`tcp:${connection.port}`);
    merged.set(host, evidence);
  }

  const hosts = [...merged.entries()]
    .map(([host, evidence]) => ({ host, evidence: [...evidence] }))
    .sort((a, b) => {
      const aConnected = a.evidence.some((item) => item.startsWith('tcp:')) ? 1 : 0;
      const bConnected = b.evidence.some((item) => item.startsWith('tcp:')) ? 1 : 0;
      return bConnected - aConnected || a.host.localeCompare(b.host);
    })
    .slice(0, MAX_REMOTE_HOSTS);

  return { hosts, connected };
}

export function findLocalCandidates(
  processes: ProcessRow[],
  listening: ListenRow[],
  knowledge: SoftStopKnowledgeBase,
): LocalCandidate[] {
  const processByPid = new Map(processes.map((row) => [row.pid, row.name]));
  const listeningByPid = new Map<number, number[]>();
  for (const row of listening) {
    const list = listeningByPid.get(row.pid) ?? [];
    list.push(row.port);
    listeningByPid.set(row.pid, list);
  }

  const candidates: LocalCandidate[] = [];
  const seen = new Set<string>();

  for (const adapter of knowledge.adapters) {
    if (adapter.kind !== 'http' || !adapter.http || adapter.spawnOnly) continue;
    const http = adapter.http;
    const push = (candidate: LocalCandidate): void => {
      const key = `${candidate.adapterId}|${candidate.pid ?? 'x'}|${candidate.port ?? 'x'}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    for (const process of processes) {
      if (!adapterMatchesProcess(adapter, process.name)) continue;
      const ports = (listeningByPid.get(process.pid) ?? []).filter((port) =>
        adapterMatchesPort(adapter, port),
      );
      const port = ports[0] ?? null;
      push({
        adapterId: adapter.id,
        label: adapter.label,
        port,
        pid: process.pid,
        processName: process.name,
        processMatched: true,
        base: http.base,
        discoverPath: http.discover?.path ?? '',
        modelPath: http.discover?.modelPath,
        fallbackPath: http.discover?.fallbackPath,
        fallbackModelPath: http.discover?.fallbackModelPath,
      });
    }

    for (const row of listening) {
      if (!adapterMatchesPort(adapter, row.port)) continue;
      const processName = processByPid.get(row.pid) ?? null;
      if (processName && adapterMatchesProcess(adapter, processName)) continue;
      push({
        adapterId: adapter.id,
        label: adapter.label,
        port: row.port,
        pid: row.pid,
        processName,
        processMatched: false,
        base: http.base,
        discoverPath: http.discover?.path ?? '',
        modelPath: http.discover?.modelPath,
        fallbackPath: http.discover?.fallbackPath,
        fallbackModelPath: http.discover?.fallbackModelPath,
      });
    }

  }

  return candidates
    .sort((a, b) => Number(b.processMatched) - Number(a.processMatched))
    .slice(0, 16);
}

export interface ProbeResult {
  ok: boolean;
  idle: boolean;
  model: string;
  path: string;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return { ok: false, status: response.status, payload: null };
  const body = await response.text();
  if (body.length > 2_000_000) return { ok: false, status: response.status, payload: null };
  try {
    return { ok: true, status: response.status, payload: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, status: response.status, payload: null };
  }
}

async function probeCandidate(
  candidate: LocalCandidate,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (!candidate.discoverPath) return { ok: true, idle: false, model: '', path: '' };
  const base = candidate.base.replace(/\/+$/, '');
  const primary = await fetchJson(`${base}${candidate.discoverPath}`, fetchImpl, timeoutMs).catch(() => ({
    ok: false,
    status: 0,
    payload: null,
  }));
  if (primary.ok) {
    const model = pickModelFromPayload(primary.payload, {
      path: candidate.discoverPath,
      modelPath: candidate.modelPath,
    });
    if (model) return { ok: true, idle: false, model, path: candidate.discoverPath };
    if (candidate.fallbackPath) {
      const fallback = await fetchJson(
        `${base}${candidate.fallbackPath}`,
        fetchImpl,
        timeoutMs,
      ).catch(() => ({ ok: false, status: 0, payload: null }));
      if (fallback.ok) {
        const fallbackModel = pickModelFromPayload(fallback.payload, {
          path: candidate.fallbackPath,
          modelPath: candidate.fallbackModelPath,
        });
        return {
          ok: true,
          idle: true,
          model: fallbackModel,
          path: candidate.fallbackPath,
        };
      }
    }
    return { ok: true, idle: true, model: '', path: candidate.discoverPath };
  }
  return { ok: false, idle: true, model: '', path: candidate.discoverPath };
}

async function resolveLocalRuntimes(
  candidates: LocalCandidate[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LocalAiRuntime[]> {
  const probeCache = new Map<string, Promise<ProbeResult>>();
  const runtimes = new Map<string, LocalAiRuntime>();

  await Promise.all(
    candidates.map(async (candidate) => {
      const key = `${candidate.base}|${candidate.discoverPath}`;
      let probe = probeCache.get(key);
      if (!probe) {
        probe = probeCandidate(candidate, fetchImpl, timeoutMs);
        probeCache.set(key, probe);
      }
      const result = await probe;
      const confirmedByProcessAndPort = candidate.processMatched && candidate.port !== null;
      if (!result.ok && !confirmedByProcessAndPort) return;

      const endpointKey = `${candidate.adapterId}|${candidate.base}`;
      const existing = runtimes.get(endpointKey);
      const evidence = new Set(existing?.evidence ?? []);
      if (candidate.processName) evidence.add(`process:${candidate.processName}`);
      if (candidate.port !== null) evidence.add(`port:${candidate.port}`);
      if (result.ok) evidence.add(`api:${result.path}`);
      if (result.model) evidence.add(`model:${result.model}`);
      if (result.idle) evidence.add('idle');
      if (existing) {
        for (const item of evidence) {
          if (!existing.evidence.includes(item)) existing.evidence.push(item);
        }
        if (existing.port === null && candidate.port !== null) {
          existing.port = candidate.port;
          existing.pid = candidate.pid;
          if (candidate.processName) existing.process = candidate.processName;
        }
        return;
      }
      runtimes.set(endpointKey, {
        id: candidate.adapterId,
        label: candidate.label,
        process: candidate.processName ?? candidate.adapterId,
        pid: candidate.pid,
        port: candidate.port,
        evidence: [...evidence],
      });
    }),
  );

  return [...runtimes.values()];
}

export interface StreamingAssessment {
  streaming: AiStreamingLevel;
  confidence: number;
  evidence: string[];
}

export function assessStreaming(
  local: LocalAiRuntime[],
  remote: RemoteAiHost[],
  throughputBps: number,
): StreamingAssessment {
  const connected = remote.some((host) => host.evidence.some((item) => item.startsWith('tcp:')));
  const activeLocal = local.filter((runtime) => !runtimeIsIdle(runtime));
  const evidence = new Set<string>();
  if (throughputBps > 0) evidence.add(`throughput:${Math.round(throughputBps / 1024)}KB/s`);
  for (const runtime of local) {
    evidence.add(`local:${runtime.id}${runtimeIsIdle(runtime) ? ':idle' : ''}`);
  }
  for (const host of remote) evidence.add(`remote:${host.host}`);

  if (connected && throughputBps >= 15_000) {
    return { streaming: 'likely', confidence: 0.9, evidence: [...evidence] };
  }
  if (connected) {
    return { streaming: 'suspected', confidence: 0.65, evidence: [...evidence] };
  }
  if (activeLocal.length > 0) {
    return { streaming: 'suspected', confidence: 0.6, evidence: [...evidence] };
  }
  if (remote.length > 0 && throughputBps >= 40_000) {
    return { streaming: 'suspected', confidence: 0.45, evidence: [...evidence] };
  }
  return {
    streaming: 'none',
    confidence: remote.length > 0 ? 0.2 : 0,
    evidence: [...evidence],
  };
}

export class AiActivityDetector {
  private readonly options: DetectorOptions;
  private readonly cacheMs: number;
  private readonly probeTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly hostSuffixes: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: AiActivitySnapshot | null = null;
  private cachedAt = 0;
  private inflight: Promise<AiActivitySnapshot> | null = null;

  constructor(options: DetectorOptions) {
    this.options = options;
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.hostSuffixes = options.hostSuffixes ?? AI_HOST_SUFFIXES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get lastSample(): AiActivitySnapshot | null {
    return this.cached;
  }

  async snapshot(force = false): Promise<AiActivitySnapshot> {
    if (!force && this.cached && this.now() - this.cachedAt < this.cacheMs) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    const task = this.sample().finally(() => {
      this.inflight = null;
    });
    this.inflight = task;
    return task;
  }

  private async readProcesses(): Promise<ProcessRow[]> {
    try {
      const output = await runCommand(
        systemExecutable('tasklist.exe', this.options.systemRoot),
        ['/fo', 'csv', '/nh'],
        this.commandTimeoutMs,
      );
      return parseTasklistCsv(output);
    } catch (error) {
      this.options.logger.debug('soft stop: tasklist failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async readListening(): Promise<ListenRow[]> {
    try {
      const output = await runCommand(
        systemExecutable('netstat.exe', this.options.systemRoot),
        ['-ano', '-p', 'tcp'],
        this.commandTimeoutMs,
      );
      return parseListeningRows(output);
    } catch (error) {
      this.options.logger.debug('soft stop: netstat failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async readNetwork(): Promise<NetworkSample | null> {
    try {
      const output = await runPowerShell(
        NETWORK_SCRIPT,
        this.commandTimeoutMs,
        this.options.systemRoot,
      );
      return parseNetworkSample(output);
    } catch (error) {
      this.options.logger.debug('soft stop: network sample failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async sample(): Promise<AiActivitySnapshot> {
    const started = this.now();
    const [processes, listening, network] = await Promise.all([
      this.readProcesses(),
      this.readListening(),
      this.readNetwork(),
    ]);

    const throughputBps = network ? throughputFromSample(network) : 0;
    const adapters = network ? classifyNetworkAdapters(network.adapters) : [];
    const remote = network
      ? detectRemoteHosts(network.dns, network.connections, this.hostSuffixes)
      : { hosts: [], connected: false };

    let local: LocalAiRuntime[] = [];
    if (processes.length > 0 || listening.length > 0) {
      const candidates = findLocalCandidates(processes, listening, this.options.knowledge);
      local = await resolveLocalRuntimes(candidates, this.fetchImpl, this.probeTimeoutMs);
    }

    const assessment = assessStreaming(local, remote.hosts, throughputBps);
    const evidence = new Set<string>(assessment.evidence);
    for (const adapter of adapters) {
      if (adapter.up) evidence.add(`net:${adapter.type}`);
    }
    if (!network) evidence.add('network-unavailable');

    const snapshot: AiActivitySnapshot = {
      ts: started,
      network: { adapters, throughputBps },
      local,
      remote: remote.hosts,
      streaming: assessment.streaming,
      confidence: assessment.confidence,
      evidence: [...evidence],
    };
    this.cached = snapshot;
    this.cachedAt = this.now();
    this.options.logger.info('soft stop: activity sample', {
      local: local.map((runtime) => runtime.id),
      remoteHosts: remote.hosts.length,
      connected: remote.connected,
      streaming: assessment.streaming,
      throughputKbps: Math.round(throughputBps / 1024),
      adapters: adapters.filter((adapter) => adapter.up).map((adapter) => adapter.type),
    });
    return snapshot;
  }
}

export function emptySnapshot(): AiActivitySnapshot {
  return {
    ts: Date.now(),
    network: { adapters: [], throughputBps: 0 },
    local: [],
    remote: [],
    streaming: 'none',
    confidence: 0,
    evidence: [],
  };
}
