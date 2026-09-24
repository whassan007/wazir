/**
 * Centralized Layout Engine & Viewport Geometry.
 * Determines panel boundaries, handles minimum size fallbacks, and manages clipping.
 */

import { TerminalFrame } from './frame.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalViewport {
  width: number;
  height: number;
  isTooSmall: boolean;
  headerRect: Rect;
  headerDividerRect: Rect;
  contentRect: Rect;
  sidebarRect?: Rect;
  mainRect: Rect;
  historyRect: Rect;
  statusDividerRect: Rect;
  statusRect: Rect;
  promptRect: Rect;
}

export const MIN_TERMINAL_WIDTH = 80;
export const MIN_TERMINAL_HEIGHT = 24;

export class LayoutEngine {
  /**
   * Computes the viewport layout for the given dimensions and sidebar visibility mode.
   */
  static computeViewport(
    width: number,
    height: number,
    sidebarMode: 'full' | 'focused' | 'hidden' = 'full',
  ): TerminalViewport {
    const isTooSmall = width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT;

    // Header: Row 0
    const headerRect: Rect = { x: 0, y: 0, width, height: 1 };
    // Header divider: Row 1
    const headerDividerRect: Rect = { x: 0, y: 1, width, height: 1 };

    // History: Row height - 4
    const historyRect: Rect = { x: 0, y: Math.max(2, height - 4), width, height: 1 };
    // Status divider: Row height - 3
    const statusDividerRect: Rect = { x: 0, y: Math.max(3, height - 3), width, height: 1 };
    // Status bar: Row height - 2
    const statusRect: Rect = { x: 0, y: Math.max(4, height - 2), width, height: 1 };
    // Prompt: Row height - 1
    const promptRect: Rect = { x: 0, y: Math.max(5, height - 1), width, height: 1 };

    // Content region spans between Row 2 and History
    const contentY = 2;
    const contentHeight = Math.max(1, height - 6);
    const contentRect: Rect = { x: 0, y: contentY, width, height: contentHeight };

    // Sidebar & Main pane split
    const isSplit = width >= 100 && sidebarMode !== 'hidden';
    let sidebarRect: Rect | undefined;
    let mainRect: Rect;

    if (isSplit) {
      const sidebarWidth = Math.max(26, Math.min(36, Math.floor(width * 0.28)));
      sidebarRect = { x: 0, y: contentY, width: sidebarWidth, height: contentHeight };
      mainRect = {
        x: sidebarWidth + 1, // account for divider '|'
        y: contentY,
        width: Math.max(1, width - sidebarWidth - 1),
        height: contentHeight,
      };
    } else {
      mainRect = { x: 0, y: contentY, width, height: contentHeight };
    }

    return {
      width,
      height,
      isTooSmall,
      headerRect,
      headerDividerRect,
      contentRect,
      sidebarRect,
      mainRect,
      historyRect,
      statusDividerRect,
      statusRect,
      promptRect,
    };
  }

  /**
   * Renders the minimum dimension fallback screen into a frame.
   */
  static renderFallbackScreen(frame: TerminalFrame): void {
    const width = frame.width;
    const height = frame.height;

    frame.fillRect({ x: 0, y: 0, width, height }, ' ');

    const title = 'Wazir';
    const msg1 = 'Terminal too small.';
    const msg2 = `Minimum: ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}`;
    const msg3 = `Current: ${width}x${height}`;

    const startY = Math.max(0, Math.floor((height - 4) / 2));

    const writeCentered = (y: number, text: string, bold = false) => {
      if (y >= 0 && y < height) {
        const x = Math.max(0, Math.floor((width - text.length) / 2));
        frame.writeText(x, y, text, { bold });
      }
    };

    writeCentered(startY, title, true);
    writeCentered(startY + 1, msg1);
    writeCentered(startY + 2, msg2);
    writeCentered(startY + 3, msg3);
  }
}
