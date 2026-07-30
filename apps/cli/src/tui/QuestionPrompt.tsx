import type { AskQuestionItem, InteractionRequest } from "@deyin/agent-core";
import { Box, Text } from "ink";
import { useState } from "react";
import { Picker, type PickerItem } from "./Picker.js";

interface Props {
  title?: string;
  questions: AskQuestionItem[];
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

export function QuestionPrompt({ title, questions, onSubmit, onCancel }: Props): JSX.Element {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const question = questions[index];

  if (!question) {
    onSubmit(answers);
    return <Text dimColor>Submitting answers…</Text>;
  }

  const items: PickerItem[] = question.options.map((opt) => ({
    value: opt.id,
    label: opt.label,
  }));

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {title?.trim() || "Choose an option"}
      </Text>
      <Text>
        {question.prompt}
        <Text dimColor>{` (${index + 1}/${questions.length})`}</Text>
      </Text>
      <Picker
        title={question.allow_multiple ? "Select one (multi-select TUI coming soon)" : question.prompt}
        items={items}
        onSelect={(value) => {
          const nextAnswers = {
            ...answers,
            [question.id]: question.allow_multiple ? [value] : value,
          };
          if (index + 1 >= questions.length) {
            onSubmit(nextAnswers);
            return;
          }
          setAnswers(nextAnswers);
          setIndex(index + 1);
        }}
        onCancel={onCancel}
      />
    </Box>
  );
}

export type AskQuestionRequest = Extract<InteractionRequest, { type: "ask-question" }>;
