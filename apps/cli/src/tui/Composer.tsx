import { Box, Text, useInput } from "ink";
import { useRef } from "react";

/**
 * Single-line composer with history navigation. Multi-line pastes are accepted
 * verbatim (newlines preserved); Enter submits, Ctrl+U clears.
 */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  active: boolean;
  history: string[];
  placeholder: string;
}): JSX.Element {
  const historyIndex = useRef<number | null>(null);

  useInput(
    (input, key) => {
      if (key.return) {
        historyIndex.current = null;
        props.onSubmit(props.value);
        return;
      }
      if (key.backspace || key.delete) {
        props.onChange(props.value.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        const h = props.history;
        if (h.length === 0) return;
        historyIndex.current = historyIndex.current === null ? h.length - 1 : Math.max(0, historyIndex.current - 1);
        props.onChange(h[historyIndex.current] ?? "");
        return;
      }
      if (key.downArrow) {
        const h = props.history;
        if (historyIndex.current === null) return;
        historyIndex.current = historyIndex.current + 1;
        if (historyIndex.current >= h.length) {
          historyIndex.current = null;
          props.onChange("");
        } else {
          props.onChange(h[historyIndex.current] ?? "");
        }
        return;
      }
      if (key.ctrl && input === "u") {
        props.onChange("");
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) {
        historyIndex.current = null;
        props.onChange(props.value + input.replace(/\r/g, "\n"));
      }
    },
    { isActive: props.active },
  );

  const shown = props.value.length > 0 ? props.value : "";
  return (
    <Box borderStyle="round" borderColor={props.active ? "cyan" : "gray"} paddingX={1}>
      <Text color="cyan" bold>
        {"\u276f "}
      </Text>
      {shown ? (
        <Text>
          {shown}
          {props.active ? <Text inverse> </Text> : null}
        </Text>
      ) : (
        <Text dimColor>{props.placeholder}</Text>
      )}
    </Box>
  );
}
