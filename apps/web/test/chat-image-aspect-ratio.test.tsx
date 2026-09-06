// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ContentBlock } from '@loomic/shared';
import { ChatMessage } from '../src/components/chat-message';

afterEach(cleanup);

it('shows generated media without a forced square crop or hover zoom', () => {
  const blocks = [{ type: 'tool', toolName: 'generate_image', toolCallId: 'image-test', status: 'completed',
    artifacts: [{ type: 'image', url: 'https://example.test/image.png', title: 'Landscape preview', width: 1024, height: 1024, mimeType: 'image/png' }],
  }] as unknown as ContentBlock[];
  render(<ChatMessage role="assistant" contentBlocks={blocks} />);
  const image = screen.getByRole('img', { name: 'Landscape preview' });
  expect(image).toHaveClass('h-auto', 'object-contain');
  expect(image).not.toHaveClass('object-cover', 'h-full', 'group-hover:scale-[1.03]');
  expect(image.parentElement).not.toHaveClass('aspect-square');
});
