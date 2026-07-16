import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WizardDraft } from './wizard-form.utils.js';
import { ReviewStep } from './review-step.component.js';

/** Builds a fully-populated draft covering every field, including the optional ones; override per test. */
function makeFullDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: 'Connect at {hostname}',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    file_seeds: [{ path: '/data/server.properties', content: 'foo=bar', content_base64: '', mode: '' }],
    ...overrides,
  };
}

describe('ReviewStep — fully-populated draft', () => {
  it('should render every field of a fully-populated draft, including optional sections', () => {
    render(<ReviewStep draft={makeFullDraft()} />);

    expect(screen.getByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('itzg/minecraft-server')).toBeInTheDocument();
    expect(screen.getByText('Connect at {hostname}')).toBeInTheDocument();
    expect(screen.getByText('1024')).toBeInTheDocument();
    expect(screen.getByText('2048')).toBeInTheDocument();
    expect(screen.getByText('25565')).toBeInTheDocument();
    expect(screen.getByText('tcp')).toBeInTheDocument();
    expect(screen.getByText('data')).toBeInTheDocument();
    expect(screen.getByText('/data')).toBeInTheDocument();
    expect(screen.getByText('File seeds')).toBeInTheDocument();
    expect(screen.getByText('/data/server.properties')).toBeInTheDocument();
  });
});

describe('ReviewStep — empty optional sections', () => {
  it('should not render a Connect message row when connect_message is blank', () => {
    render(<ReviewStep draft={makeFullDraft({ connect_message: '' })} />);

    expect(screen.queryByText('Connect message')).not.toBeInTheDocument();
  });

  it('should not render a Connect message row when connect_message is only whitespace', () => {
    render(<ReviewStep draft={makeFullDraft({ connect_message: '   ' })} />);

    expect(screen.queryByText('Connect message')).not.toBeInTheDocument();
  });

  it('should not render the File seeds section when file_seeds is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ file_seeds: [] })} />);

    expect(screen.queryByText('File seeds')).not.toBeInTheDocument();
  });

  it('should show a "no ports configured" placeholder when ports is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ ports: [] })} />);

    expect(screen.getByText('No ports configured.')).toBeInTheDocument();
  });

  it('should show a "no volumes configured" placeholder when volumes is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ volumes: [] })} />);

    expect(screen.getByText('No volumes configured.')).toBeInTheDocument();
  });
});

describe('ReviewStep — submit errors', () => {
  it('should not render an alert when submitError is not provided', () => {
    render(<ReviewStep draft={makeFullDraft()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should display the provided submit error message', () => {
    const message = 'A game named "minecraft" already exists.';
    render(<ReviewStep draft={makeFullDraft()} submitError={message} />);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});
