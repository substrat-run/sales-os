import { useEffect, useRef, type ReactNode } from 'react';
import '@substrat-run/elements';
import type { SubEntityTable } from '@substrat-run/elements/entity-table';
import type { ColumnSpec, TableSource } from '@substrat-run/elements/entity-table-model';
import type { SubUserMenu } from '@substrat-run/elements/user-menu';
import type { SubKanban } from '@substrat-run/elements/kanban';
import type { KanbanColumn, KanbanMove } from '@substrat-run/elements/kanban-model';
import type {} from '@substrat-run/elements/jsx';

// ============================================================================
// `@substrat-run/elements` in React 18. The elements are standard web components, so React
// passes them attributes only: properties (`source`, `columns`) and events go through a ref.
// ============================================================================

type El = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & Record<string, unknown>;
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': El;
      'sub-user-menu': El;
      'sub-kanban': El;
      'sub-avatar': El;
      'sub-assistant': El;
      'wa-dialog': El;
      'wa-input': El;
    }
  }
}

export type { ColumnSpec, TableSource };

type Filters = SubEntityTable['filters'];

interface TableProps<T> {
  /** The table's accessible name. */
  label: string;
  /** Keep this identity stable (useMemo): a new source starts the table over. */
  source: TableSource<T>;
  columns: ColumnSpec<T>[];
  filters?: Filters;
  /** Change it to read the table again, e.g. after a row was added elsewhere on the screen. */
  reloadKey?: number;
  pageSize?: number;
  /** Shown when there is nothing at all, in place of the default text. */
  empty?: ReactNode;
}

/** One paged read, drawn by `<sub-entity-table>`: server-side paging, search and filters, and 403/empty states told apart. */
export function EntityTable<T>({ label, source, columns, filters, reloadKey, pageSize, empty }: TableProps<T>) {
  const ref = useRef<SubEntityTable<T>>(null);
  const seen = useRef(reloadKey);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.source = source as never;
    t.columns = columns as never;
    if (filters) t.filters = filters;
  }, [source, columns, filters]);
  useEffect(() => {
    if (seen.current === reloadKey) return;
    seen.current = reloadKey;
    void ref.current?.reload();
  }, [reloadKey]);
  return (
    <sub-entity-table ref={ref} aria-label={label} density="compact" {...(pageSize ? { 'page-size': String(pageSize) } : {})}>
      {empty ? <div slot="empty">{empty}</div> : null}
    </sub-entity-table>
  );
}

/** The account menu: who is signed in, switch user, sign out. Reads `/api/me` itself unless handed the session. */
export function UserMenu({ session }: { session?: { principal: string; display: string } }) {
  const ref = useRef<SubUserMenu>(null);
  useEffect(() => {
    if (ref.current && session) ref.current.session = session;
  }, [session]);
  // `session-url=""` stops it reading again when the host already holds the session (React sets properties late).
  return <sub-user-menu ref={ref} show="name" {...(session ? { 'session-url': '' } : {})} />;
}

export type { KanbanColumn, KanbanMove };

interface BoardProps<T> {
  label: string;
  columns: KanbanColumn[];
  cards: T[];
  keyOf: (card: T) => string;
  columnOf: (card: T) => string;
  labelOf: (card: T) => string;
  /** Draw a card into a light-DOM element. Plain DOM: a separate React root would lose the app's contexts. */
  mount: (el: HTMLElement, card: T) => { update?(card: T): void; unmount?(): void } | void;
  canDrag?: (card: T) => boolean;
  canDrop?: (card: T, from: string, to: string) => boolean;
  /** Persist a move. Reject to send the card back. */
  move: (move: KanbanMove<T>) => Promise<unknown>;
  onOpen?: (card: T) => void;
  onFailed?: (error: unknown) => void;
  /** Hand back the element, for `moveTo` from a menu. */
  boardRef?: React.MutableRefObject<SubKanban<T> | null>;
}

/** `<sub-kanban>`: cards in columns, moved by drag or keyboard. The screen decides what a move means. */
export function Board<T>(p: BoardProps<T>) {
  const ref = useRef<SubKanban<T>>(null);
  useEffect(() => {
    const k = ref.current;
    if (!k) return;
    if (p.boardRef) p.boardRef.current = k;
    k.columns = p.columns;
    k.keyOf = p.keyOf;
    k.columnOf = p.columnOf;
    k.labelOf = p.labelOf;
    k.mount = p.mount;
    k.canDrag = p.canDrag;
    k.canDrop = p.canDrop;
    k.move = p.move;
    const open = (e: Event) => p.onOpen?.((e as CustomEvent<{ card: T }>).detail.card);
    const failed = (e: Event) => p.onFailed?.((e as CustomEvent<{ error: unknown }>).detail.error);
    k.addEventListener('sub-card-open', open);
    k.addEventListener('sub-move-failed', failed);
    return () => {
      k.removeEventListener('sub-card-open', open);
      k.removeEventListener('sub-move-failed', failed);
    };
  });
  useEffect(() => {
    if (ref.current) ref.current.cards = p.cards;
  }, [p.cards]);
  return <sub-kanban ref={ref} label={p.label} />;
}
