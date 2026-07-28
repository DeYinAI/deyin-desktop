import type { PermissionDecision, PermissionRequest } from "@deyin/agent-core";
import { Box, Text, useInput } from "ink";

export function PermissionPrompt(props: {
  request: PermissionRequest;
  onDecision: (decision: PermissionDecision) => void;
}): JSX.Element {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y" || key.return) props.onDecision("allow");
    else if (c === "a") props.onDecision("allow-always");
    else if (c === "n" || key.escape) props.onDecision("deny");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>
        {props.request.toolName}
        <Text dimColor>{`  ${props.request.summary}`}</Text>
      </Text>
      <Text dimColor>[y] allow once   [a] always allow this session   [n] deny</Text>
    </Box>
  );
}
