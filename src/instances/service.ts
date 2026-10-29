/**
 * Runs the instance scan with at most one in flight: opening the settings tab
 * repeatedly, or a server start during a scan, shares the running scan. A
 * request with a different custom CLI path waits for the running scan, then
 * scans again, so two scans are never in flight together.
 */
import { resolveInstanceForStart, scanInstances, type Instance, type ScanOptions, type ScanResult, type StartScanOptions } from "./scan";

export class InstanceService {
  private inflight: { key: string; promise: Promise<ScanResult> } | null = null;
  /** Scans started so far (tests count them). */
  started = 0;

  /** Server-start resolutions so far (tests count them). */
  resolved = 0;

  constructor(
    private readonly run: (o: ScanOptions) => Promise<ScanResult> = scanInstances,
    private readonly resolveRun: (o: StartScanOptions) => Promise<Instance | null> = resolveInstanceForStart,
  ) {}

  /**
   * The instance a server start runs on (see `resolveInstanceForStart`): only the saved or default build
   * is probed, so a hanging build that is not going to be used cannot delay the start.
   */
  forStart(customCliPath: string | null, savedId: string | null): Promise<Instance | null> {
    this.resolved++;
    return this.resolveRun({ customCliPath, savedId });
  }

  scan(customCliPath: string | null): Promise<ScanResult> {
    const key = customCliPath ?? "";
    const current = this.inflight;
    if (current && current.key === key) return current.promise;
    const begin = () => {
      this.started++;
      return this.run({ customCliPath });
    };
    const promise: Promise<ScanResult> = (current ? current.promise.then(begin, begin) : begin()).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { key, promise };
    return promise;
  }
}
