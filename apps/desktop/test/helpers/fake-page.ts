import vm from "node:vm";
import { TEACH_DRAIN_SCRIPT, TEACH_PAGE_SCRIPT } from "../../src/main/bots/teach-page-script.js";

/* A page to run the script in: just enough of a document for its events, labels and selectors. */

export interface FakeProps {
  attrs?: Record<string, string>;
  type?: string;
  value?: string;
  text?: string;
  labels?: FakeElement[];
  selected?: FakeElement[];
  editable?: boolean;
  parent?: FakeElement;
  id?: string;
}

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attrs: Record<string, string>;
  type: string | undefined;
  value: string | undefined;
  textContent: string;
  innerText: string;
  labels: FakeElement[];
  selectedOptions: FakeElement[];
  isContentEditable: boolean;
  parent: FakeElement | undefined;

  constructor(tag: string, props: FakeProps = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...(props.attrs ?? {}), ...(props.id ? { id: props.id } : {}) };
    this.type = props.type;
    this.value = props.value;
    this.textContent = props.text ?? "";
    this.innerText = props.text ?? "";
    this.labels = props.labels ?? [];
    this.selectedOptions = props.selected ?? [];
    this.isContentEditable = props.editable === true;
    this.parent = props.parent;
  }

  getAttribute(name: string): string | null {
    if (name === "type" && this.type !== undefined && !(name in this.attrs)) return this.type;
    return name in this.attrs ? this.attrs[name]! : null;
  }

  /** The kinds of selector the script uses: `tag`, `[attr=value]` and `tag[attr=value]`, in a comma list. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const found = /^([a-z]*)(?:\[([a-z-]+)=([^\]]+)\])?$/.exec(part.trim());
      if (!found) throw new Error(`The fake page does not understand "${part}"`);
      const [, tag, attr, value] = found;
      if (tag && this.tagName.toLowerCase() !== tag) return false;
      if (attr && this.getAttribute(attr) !== value) return false;
      return Boolean(tag || attr);
    });
  }

  closest(selector: string): FakeElement | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
}

type Listener = (event: Record<string, unknown>) => void;

export function page() {
  const listeners = new Map<string, Array<{ fn: Listener; capture: boolean }>>();
  const byId = new Map<string, FakeElement>();
  const document = {
    addEventListener: (type: string, fn: Listener, capture: boolean) => {
      listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture }]);
    },
    getElementById: (id: string) => byId.get(id) ?? null,
  };
  const context = vm.createContext({ document, window: {} as Record<string, unknown> });
  const install = (): unknown => vm.runInContext(TEACH_PAGE_SCRIPT, context);
  const drain = (): unknown[] => JSON.parse(JSON.stringify(vm.runInContext(TEACH_DRAIN_SCRIPT, context)));
  const fire = (type: string, target: FakeElement, extra: Record<string, unknown> = {}, trusted = true) => {
    for (const { fn } of listeners.get(type) ?? []) fn({ type, target, isTrusted: trusted, ...extra });
  };
  return { install, drain, fire, listeners, byId, context };
}

export function field(tag: string, props: FakeProps = {}): FakeElement {
  return new FakeElement(tag, props);
}

