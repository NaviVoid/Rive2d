import type { RuntimeLogger } from './contracts';

export interface ResourcePreloader {
  prepare(modelPath: string): Promise<void>;
}

export class TauriResourcePreloader implements ResourcePreloader {
  constructor(
    private readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
    private readonly logger: RuntimeLogger,
  ) {}

  async prepare(modelPath: string): Promise<void> {
    if (!modelPath.startsWith('model://') && !modelPath.toLowerCase().includes('.lpk')) return;
    try {
      await this.invoke('prepare_model_assets', { path: modelPath });
      this.logger.info('model resources prepared', { modelPath });
    } catch (error) {
      this.logger.warn('model resource preparation failed; protocol loader will retry', { modelPath, error: String(error) });
    }
  }
}
