import { describe, expect, it } from 'vitest';
import {
  adapterTypeFor,
  assessStreaming,
  classifyNetworkAdapters,
  detectRemoteHosts,
  emptySnapshot,
  findLocalCandidates,
  hostMatchesSuffix,
  parseListeningRows,
  parseNetworkSample,
  parseTasklistCsv,
  throughputFromSample,
} from '../electron/core/ai-detect';
import { BUILTIN_KNOWLEDGE } from '../electron/core/knowledge';

describe('tasklist and netstat parsing', () => {
  it('reads image names and pids from CSV output', () => {
    const output = [
      '"ollama.exe","1234","Console","1","120,000 K"',
      '"LM Studio.exe","5678","Console","1","80,000 K"',
      'garbage line',
    ].join('\r\n');
    expect(parseTasklistCsv(output)).toEqual([
      { name: 'ollama.exe', pid: 1234 },
      { name: 'LM Studio.exe', pid: 5678 },
    ]);
  });

  it('reads IPv4 and IPv6 listening sockets', () => {
    const output = [
      '  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       1234',
      '  TCP    [::]:11434             [::]:0                 LISTENING       1234',
      '  TCP    0.0.0.0:1234           0.0.0.0:0              LISTENING       5678',
      '  TCP    10.0.0.2:50000         10.0.0.1:443           ESTABLISHED     9999',
    ].join('\r\n');
    expect(parseListeningRows(output)).toEqual([
      { port: 11434, pid: 1234 },
      { port: 11434, pid: 1234 },
      { port: 1234, pid: 5678 },
    ]);
  });
});

describe('network sample', () => {
  const sample = {
    adapters: [{ name: 'Wi-Fi', description: 'Intel Wi-Fi 6E AX211', up: true }],
    dns: [{ entry: 'api.openai.com', data: '1.2.3.4' }],
    connections: [{ remote: '1.2.3.4', port: 443, pid: 42 }],
    bytesIn: 1000,
    bytesOut: 500,
    bytesIn2: 8000,
    bytesOut2: 1500,
    elapsedMs: 700,
  };

  it('parses a single PowerShell object and array-wrapped output', () => {
    expect(parseNetworkSample(JSON.stringify(sample)).dns[0].name).toBe('api.openai.com');
    expect(parseNetworkSample(JSON.stringify([sample])).connections[0].port).toBe(443);
    expect(() => parseNetworkSample('null')).toThrow();
  });

  it('computes combined throughput over the sampled interval', () => {
    expect(throughputFromSample(parseNetworkSample(JSON.stringify(sample)))).toBe(
      Math.round(8000 / 0.7),
    );
    expect(
      throughputFromSample({ ...parseNetworkSample(JSON.stringify(sample)), bytesIn2: 0 }),
    ).toBe(0);
    expect(
      throughputFromSample({ ...parseNetworkSample(JSON.stringify(sample)), elapsedMs: 0 }),
    ).toBe(Math.round(8000 / 0.2));
  });

  it('classifies adapter types and keeps the up flag', () => {
    expect(adapterTypeFor('Wi-Fi 2', 'Intel(R) Wi-Fi 6E AX211 160MHz')).toBe('wifi');
    expect(adapterTypeFor('Cellular', 'Generic Mobile Broadband Adapter LTE')).toBe('wwan');
    expect(adapterTypeFor('Ethernet', 'Realtek Gaming 2.5GbE Family Controller')).toBe('ethernet');
    expect(adapterTypeFor('VPN', 'TAP-Windows Adapter V9')).toBe('other');
    expect(adapterTypeFor('vEthernet (Default Switch)', 'Hyper-V Virtual Ethernet Adapter')).toBe(
      'other',
    );
    expect(
      classifyNetworkAdapters([
        { name: 'Wi-Fi', description: 'Wireless', up: true },
        { name: 'Wi-Fi', description: 'Wireless', up: true },
        { name: 'Ethernet', description: 'Realtek', up: false },
      ]),
    ).toEqual([
      { name: 'Wi-Fi', type: 'wifi', up: true },
      { name: 'Ethernet', type: 'ethernet', up: false },
    ]);
  });
});

describe('remote AI hosts', () => {
  it('matches only exact hosts and subdomains', () => {
    expect(hostMatchesSuffix('api.openai.com', ['openai.com'])).toBe(true);
    expect(hostMatchesSuffix('openai.com', ['openai.com'])).toBe(true);
    expect(hostMatchesSuffix('evilopenai.com', ['openai.com'])).toBe(false);
    expect(hostMatchesSuffix('API.OpenAI.com.', ['openai.com'])).toBe(true);
  });

  it('correlates DNS cache entries with established connections', () => {
    const result = detectRemoteHosts(
      [
        { name: 'api.openai.com', address: '1.2.3.4' },
        { name: 'api.openai.com', address: '1.2.3.5' },
        { name: 'chatgpt.com', address: '5.6.7.8' },
        { name: 'evilopenai.com', address: '9.9.9.9' },
      ],
      [
        { address: '1.2.3.4', port: 443, pid: 1 },
        { address: '::ffff:1.2.3.5', port: 443, pid: 1 },
        { address: '9.9.9.9', port: 443, pid: 1 },
        { address: '1.1.1.1', port: 443, pid: 1 },
      ],
      ['openai.com', 'chatgpt.com'],
    );
    expect(result.connected).toBe(true);
    expect(result.hosts.map((host) => host.host)).toEqual(['api.openai.com', 'chatgpt.com']);
    expect(result.hosts[0].evidence).toEqual(['dns-cache', 'tcp:443']);
    expect(result.hosts[1].evidence).toEqual(['dns-cache']);
  });

  it('reports no connection when AI hosts are only cached', () => {
    const result = detectRemoteHosts(
      [{ name: 'claude.ai', address: '5.6.7.8' }],
      [],
      ['claude.ai'],
    );
    expect(result.connected).toBe(false);
    expect(result.hosts).toHaveLength(1);
  });
});

describe('local runtime candidates', () => {
  it('matches processes and listening ports against the knowledge base', () => {
    const candidates = findLocalCandidates(
      [
        { name: 'ollama.exe', pid: 100 },
        { name: 'LM Studio.exe', pid: 500 },
        { name: 'python.exe', pid: 300 },
        { name: 'unknown.exe', pid: 400 },
      ],
      [
        { port: 11434, pid: 100 },
        { port: 8080, pid: 400 },
        { port: 5000, pid: 300 },
      ],
      BUILTIN_KNOWLEDGE,
    );
    const ollama = candidates.find((candidate) => candidate.adapterId === 'ollama');
    expect(ollama).toMatchObject({
      port: 11434,
      pid: 100,
      processName: 'ollama.exe',
      processMatched: true,
    });
    const lmStudio = candidates.find((candidate) => candidate.adapterId === 'lmstudio');
    expect(lmStudio).toMatchObject({ port: null, pid: 500, processMatched: true });
    const textgen = candidates.find((candidate) => candidate.adapterId === 'textgenwebui');
    expect(textgen).toMatchObject({ port: 5000, pid: 300, processMatched: false });
    const port8080 = candidates.filter((candidate) => candidate.port === 8080);
    expect(port8080.map((candidate) => candidate.adapterId).sort()).toEqual([
      'llamacpp',
      'llamafile',
      'localai',
    ]);
    // Process matches sort ahead of port-only matches.
    expect(candidates[0].processMatched).toBe(true);
  });
});

describe('streaming assessment', () => {
  const local = [
    {
      id: 'ollama',
      label: 'Ollama',
      process: 'ollama.exe',
      pid: 1,
      port: 11434,
      evidence: ['process:ollama.exe', 'port:11434', 'api:/api/ps', 'model:llama3'],
    },
  ];

  it('marks a connected AI host with throughput as likely', () => {
    const result = assessStreaming(
      [],
      [{ host: 'api.openai.com', evidence: ['dns-cache', 'tcp:443'] }],
      20_000,
    );
    expect(result.streaming).toBe('likely');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.evidence).toContain('throughput:20KB/s');
  });

  it('treats a connected host without throughput as suspected', () => {
    const result = assessStreaming(
      [],
      [{ host: 'api.openai.com', evidence: ['tcp:443'] }],
      0,
    );
    expect(result.streaming).toBe('suspected');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('treats a live local runtime as activity', () => {
    const result = assessStreaming(local, [], 0);
    expect(result.streaming).toBe('suspected');
    expect(result.evidence).toContain('local:ollama');
  });

  it('treats an idle local server as no activity', () => {
    const result = assessStreaming(
      [{ ...local[0], evidence: [...local[0].evidence, 'idle'] }],
      [],
      0,
    );
    expect(result.streaming).toBe('none');
    expect(result.evidence).toContain('local:ollama:idle');
  });

  it('does not call a stale DNS cache active without traffic', () => {
    const result = assessStreaming([], [{ host: 'claude.ai', evidence: ['dns-cache'] }], 0);
    expect(result.streaming).toBe('none');
    expect(result.confidence).toBeLessThan(0.3);
  });

  it('flags heavy traffic with a cached AI host as suspected', () => {
    const result = assessStreaming([], [{ host: 'claude.ai', evidence: ['dns-cache'] }], 50_000);
    expect(result.streaming).toBe('suspected');
  });
});

describe('emptySnapshot', () => {
  it('returns a defensively empty snapshot', () => {
    const snapshot = emptySnapshot();
    expect(snapshot.local).toEqual([]);
    expect(snapshot.remote).toEqual([]);
    expect(snapshot.streaming).toBe('none');
    expect(snapshot.network.adapters).toEqual([]);
  });
});
