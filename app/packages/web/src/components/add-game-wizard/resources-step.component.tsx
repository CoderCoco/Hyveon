import {
  getFargateCpuOptions,
  getFargateMemoryOptions,
  type GameServerValidationIssue,
} from '@hyveon/shared/gameServerValidator';

/** Updates the "Resources" step emits — always both fields, since a cpu change may also reset memory. */
export interface ResourcesStepChange {
  cpu: number | null;
  memory: number | null;
}

interface Props {
  cpu: number | null;
  memory: number | null;
  onChange: (change: ResourcesStepChange) => void;
  issues: GameServerValidationIssue[];
}

/**
 * "Resources" step of the add-game wizard (#99): cpu/memory selects backed
 * directly by {@link getFargateCpuOptions}/{@link getFargateMemoryOptions} so
 * the dropdowns can never offer a pairing the shared Fargate validator would
 * reject. The memory select is rebuilt from the *currently selected* cpu on
 * every render, and picking a new cpu that no longer supports the current
 * memory value resets memory back to unset rather than leaving a stale,
 * now-invalid value sitting in the draft.
 */
export function ResourcesStep({ cpu, memory, onChange, issues }: Props) {
  const cpuOptions = getFargateCpuOptions();
  const memoryOptions = cpu !== null ? getFargateMemoryOptions(cpu) : [];

  const cpuError = issues.find((issue) => issue.path === 'cpu')?.message;
  const memoryError = issues.find((issue) => issue.path === 'memory')?.message;

  /** Applies a new cpu selection, resetting `memory` to unset if it isn't a valid pairing for the new cpu. */
  function handleCpuChange(rawValue: string) {
    const nextCpu = rawValue === '' ? null : Number(rawValue);
    const validMemories = nextCpu !== null ? getFargateMemoryOptions(nextCpu) : [];
    const nextMemory = memory !== null && validMemories.includes(memory) ? memory : null;
    onChange({ cpu: nextCpu, memory: nextMemory });
  }

  function handleMemoryChange(rawValue: string) {
    onChange({ cpu, memory: rawValue === '' ? null : Number(rawValue) });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="wizard-resources-cpu" className="text-sm font-medium text-[var(--color-foreground)]">
          CPU (vCPU units)
        </label>
        <select
          id="wizard-resources-cpu"
          value={cpu ?? ''}
          onChange={(e) => handleCpuChange(e.target.value)}
          aria-invalid={cpuError ? 'true' : 'false'}
          aria-describedby={cpuError ? 'wizard-resources-cpu-error' : undefined}
          className="h-9 w-56 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
        >
          <option value="">Select CPU…</option>
          {cpuOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {cpuError && (
          <p id="wizard-resources-cpu-error" role="alert" className="text-sm text-[var(--color-red)]">
            {cpuError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="wizard-resources-memory" className="text-sm font-medium text-[var(--color-foreground)]">
          Memory (MiB)
        </label>
        <select
          id="wizard-resources-memory"
          value={memory ?? ''}
          onChange={(e) => handleMemoryChange(e.target.value)}
          disabled={cpu === null}
          aria-invalid={memoryError ? 'true' : 'false'}
          aria-describedby={memoryError ? 'wizard-resources-memory-error' : undefined}
          className="h-9 w-56 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] disabled:opacity-50"
        >
          <option value="">Select memory…</option>
          {memoryOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {memoryError && (
          <p id="wizard-resources-memory-error" role="alert" className="text-sm text-[var(--color-red)]">
            {memoryError}
          </p>
        )}
      </div>
    </div>
  );
}
