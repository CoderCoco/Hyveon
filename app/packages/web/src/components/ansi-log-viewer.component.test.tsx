import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnsiLogViewer, parseAnsiLine, type AnsiLogChunk } from './ansi-log-viewer.component.js';

/**
 * Stubs the scroll geometry (`scrollHeight`/`clientHeight`) jsdom never lays
 * out, and spies on `scrollTop` writes so tests can assert auto-scroll
 * behavior without a real layout engine.
 */
function stubScrollGeometry(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('parseAnsiLine', () => {
  it('should return a single unstyled segment for plain text', () => {
    expect(parseAnsiLine('hello world')).toEqual([{ text: 'hello world', bold: false, colorClass: null }]);
  });

  it('should apply a foreground color for a basic SGR color code', () => {
    const segments = parseAnsiLine('\x1b[32mgreen text\x1b[0m');
    expect(segments).toEqual([{ text: 'green text', bold: false, colorClass: 'text-[var(--color-green)]' }]);
  });

  it('should mark a segment bold for SGR code 1 and clear it on reset', () => {
    const segments = parseAnsiLine('\x1b[1mbold\x1b[0m normal');
    expect(segments[0]).toEqual({ text: 'bold', bold: true, colorClass: null });
    expect(segments[1]).toEqual({ text: ' normal', bold: false, colorClass: null });
  });

  it('should combine bold and color from a single semicolon-joined SGR code', () => {
    const segments = parseAnsiLine('\x1b[1;31mdestroy\x1b[0m');
    expect(segments).toEqual([{ text: 'destroy', bold: true, colorClass: 'text-[var(--color-red)]' }]);
  });

  it('should ignore unrecognized SGR codes instead of throwing', () => {
    expect(() => parseAnsiLine('\x1b[48;5;200munsupported bg\x1b[0m')).not.toThrow();
    expect(parseAnsiLine('\x1b[999mplain\x1b[0m')[0]!.text).toBe('plain');
  });
});

describe('AnsiLogViewer', () => {
  it('should render an empty-state message when there are no chunks', () => {
    render(<AnsiLogViewer chunks={[]} />);
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
  });

  it('should render a custom empty message when supplied', () => {
    render(<AnsiLogViewer chunks={[]} emptyMessage="Nothing yet" />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('should render chunks in order', () => {
    const chunks: AnsiLogChunk[] = [
      { stream: 'stdout', line: 'first line' },
      { stream: 'stdout', line: 'second line' },
    ];
    render(<AnsiLogViewer chunks={chunks} />);
    const lines = screen.getByTestId('ansi-log-viewer').querySelectorAll('div > div');
    expect(lines[0]).toHaveTextContent('first line');
    expect(lines[1]).toHaveTextContent('second line');
  });

  it('should render an ANSI-colored line as styled spans', () => {
    render(<AnsiLogViewer chunks={[{ stream: 'stdout', line: '\x1b[31merror text\x1b[0m' }]} />);
    const span = screen.getByText('error text');
    expect(span.className).toContain('text-[var(--color-red)]');
  });

  it('should auto-scroll to the bottom when new chunks arrive while pinned', () => {
    const chunks: AnsiLogChunk[] = [{ stream: 'stdout', line: 'a' }];
    const { container, rerender } = render(<AnsiLogViewer chunks={chunks} />);
    const box = container.querySelector('[data-testid="ansi-log-viewer"]') as HTMLDivElement;
    stubScrollGeometry(box, { scrollHeight: 500, clientHeight: 100 });

    rerender(<AnsiLogViewer chunks={[...chunks, { stream: 'stdout', line: 'b' }]} />);

    expect(box.scrollTop).toBe(500);
  });

  it('should pause auto-scroll once the user scrolls away from the bottom', () => {
    const chunks: AnsiLogChunk[] = [{ stream: 'stdout', line: 'a' }];
    const { container, rerender } = render(<AnsiLogViewer chunks={chunks} />);
    const box = container.querySelector('[data-testid="ansi-log-viewer"]') as HTMLDivElement;
    stubScrollGeometry(box, { scrollHeight: 500, clientHeight: 100 });

    // Scroll away from the bottom (far short of scrollHeight - clientHeight).
    Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 50 });
    box.dispatchEvent(new Event('scroll'));

    const scrollTopSpy = vi.spyOn(box, 'scrollTop', 'set');
    rerender(<AnsiLogViewer chunks={[...chunks, { stream: 'stdout', line: 'b' }]} />);

    expect(scrollTopSpy).not.toHaveBeenCalled();
  });

  it('should resume auto-scroll once the user scrolls back to the bottom', () => {
    const chunks: AnsiLogChunk[] = [{ stream: 'stdout', line: 'a' }];
    const { container, rerender } = render(<AnsiLogViewer chunks={chunks} />);
    const box = container.querySelector('[data-testid="ansi-log-viewer"]') as HTMLDivElement;
    stubScrollGeometry(box, { scrollHeight: 500, clientHeight: 100 });

    Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 50 });
    box.dispatchEvent(new Event('scroll'));

    Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 400 });
    box.dispatchEvent(new Event('scroll'));

    rerender(<AnsiLogViewer chunks={[...chunks, { stream: 'stdout', line: 'b' }]} />);

    expect(box.scrollTop).toBe(500);
  });
});
