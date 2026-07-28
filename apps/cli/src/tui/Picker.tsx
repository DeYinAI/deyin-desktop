import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
}

export function Picker(props: {
  title: string;
  items: PickerItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const visibleCount = 10;
  const start = Math.max(0, Math.min(index - Math.floor(visibleCount / 2), props.items.length - visibleCount));
  const visible = props.items.slice(start, start + visibleCount);

  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(props.items.length - 1, i + 1));
    else if (key.return) {
      const item = props.items[index];
      if (item) props.onSelect(item.value);
    } else if (key.escape) props.onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {props.title} <Text dimColor>(arrows + enter, esc to close)</Text>
      </Text>
      {visible.map((item, i) => {
        const absolute = start + i;
        const selected = absolute === index;
        return (
          <Text key={item.value} color={selected ? "cyan" : undefined} bold={selected}>
            {selected ? "\u276f " : "  "}
            {item.label}
            {item.hint ? <Text dimColor>{`  ${item.hint}`}</Text> : null}
          </Text>
        );
      })}
      {props.items.length === 0 ? <Text dimColor>(nothing to show)</Text> : null}
    </Box>
  );
}
