import { Fault, isActionTrigger, isBaselineResponder } from './Fault';
import { Observation } from './Evidence';

/**
 * Fault dispatch contract, L0-F2:
 * 1. Only action_<type> events enter active fault dispatch.
 * 2. Active dispatch supports participant targets only.
 * 3. A participant target must equal the current action actor.
 * 4. Lifecycle events are evidence-only; no recursive dispatch.
 * 5. Edge/infrastructure targets are declared-only.
 *
 * respond is a compatibility baseline behavior, not an active fault.
 */
export class FaultInjector {
  private faults: Map<string, Fault[]> = new Map();

  constructor(faults: Fault[] = []) {
    for (const fault of faults) {
      this.registerFault(fault);
    }
  }

  public registerFault(fault: Fault): void {
    const key = fault.trigger;
    const existing = this.faults.get(key) ?? [];
    existing.push(fault);
    this.faults.set(key, existing);
  }

  /**
   * Return runtime-applicable faults for an action.
   *
   * actorId is mandatory so target/actor cannot silently diverge.
   * Lifecycle triggers, edge/infrastructure targets, and target mismatches
   * are excluded from active dispatch.
   */
  public getFaultsForEvent(eventType: string, actorId: string): Fault[] {
    if (!isActionTrigger(eventType)) {
      return [];
    }

    return (this.faults.get(eventType) ?? []).filter((fault) => {
      if (isBaselineResponder(fault)) {
        return false;
      }
      return (
        fault.target.kind === 'participant' &&
        fault.target.participantId === actorId
      );
    });
  }

  /**
   * Compatibility path for S7's baseline seller response.
   *
   * This is deliberately NOT recursive fault dispatch and is not used for
   * lifecycle-triggered fault lookup. It exists only because respond
   * describes normal participant behavior rather than a fault.
   */
  public getRespondersForEvent(eventType: string): Fault[] {
    if (!isActionTrigger(eventType)) {
      return [];
    }

    return (this.faults.get(eventType) ?? []).filter(isBaselineResponder);
  }

  public async apply<T>(
    fault: Fault,
    operation: () => Promise<T>,
    emit?: (observation: Observation) => void
  ): Promise<T> {
    const source = fault.target.kind === 'participant'
      ? fault.target.participantId
      : null;

    switch (fault.type) {
      case 'duplicate_request':
        return this.handleDuplicateRequest(operation, fault.config);
      case 'delayed_response':
        return this.handleDelayedResponse(operation, fault.config, source, emit);
      case 'crash':
        return this.handleCrash(operation);
      case 'hang':
        return this.handleHang(operation, fault.config, source, emit);
      case 'concurrent_request':
        return this.handleConcurrentRequest(operation, fault.config);
      case 'retry':
        return this.handleRetry(operation, fault.config);
      case 'lost_delivery':
        return this.handleLostDelivery(operation, fault.config);
      case 'respond':
        return this.handleRespond(operation, fault.config, source, emit);
      default:
        return operation();
    }
  }

  private async handleDuplicateRequest<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>
  ): Promise<T> {
    const repeatCount = (config?.['repeat_count'] as number) || 2;
    let result: T | undefined;
    for (let i = 0; i < repeatCount; i++) result = await operation();
    return result!;
  }

  private async handleDelayedResponse<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>,
    source?: string | null,
    emit?: (observation: Observation) => void
  ): Promise<T> {
    const delayMs = (config?.['delay_ms'] as number) || 5000;
    if (emit && source) {
      emit({ source, type: 'delivery_started', data: {}, timestamp: Date.now() });
    }
    await this.sleep(delayMs);
    if (emit && source) {
      emit({ source, type: 'delivery_completed', data: {}, timestamp: Date.now() });
    }
    return operation();
  }

  private async handleCrash<T>(operation: () => Promise<T>): Promise<T> {
    await operation();
    throw new Error('Simulated crash');
  }

  private async handleHang<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>,
    source?: string | null,
    emit?: (observation: Observation) => void
  ): Promise<T> {
    const durationMs = (config?.['duration_ms'] as number) || -1;
    if (emit && source) {
      emit({ source, type: 'delivery_started', data: {}, timestamp: Date.now() });
    }
    if (durationMs < 0) return new Promise<T>(() => {});
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hang timeout')), durationMs);
      operation().then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(reject);
    });
  }

  private async handleConcurrentRequest<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>
  ): Promise<T> {
    const parallelCount = (config?.['parallel_count'] as number) || 5;
    const results = await Promise.all(
      Array.from({ length: parallelCount }, () => operation())
    );
    return results[0];
  }

  private async handleRetry<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>
  ): Promise<T> {
    const retryCount = (config?.['retry_count'] as number) || 3;
    let lastError: Error | undefined;
    for (let i = 0; i < retryCount; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError || new Error('All retries failed');
  }

  private async handleLostDelivery<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>
  ): Promise<T> {
    const dropProbability = (config?.['drop_probability'] as number) || 1.0;
    const result = await operation();
    if (Math.random() < dropProbability) {
      throw new Error('Delivery lost in transit');
    }
    return result;
  }

  private async handleRespond<T>(
    operation: () => Promise<T>,
    config?: Record<string, unknown>,
    source?: string | null,
    emit?: (observation: Observation) => void
  ): Promise<T> {
    if (emit && source) {
      const emitType = config?.['emit'] as string | undefined;
      if (emitType) {
        emit({ source, type: emitType, data: {}, timestamp: Date.now() });
      }
    }
    return operation();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
