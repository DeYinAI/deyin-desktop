import { Icon } from "../Icon.js";

export interface PipelineStep {
  title: string;
  detail?: string;
  done: boolean;
}

/** Vertical checkmark timeline — HYRAX finding-detail pipeline. */
export function PipelineStepper(props: { steps: PipelineStep[]; className?: string }) {
  return (
    <ol className={`ui-pipeline${props.className ? ` ${props.className}` : ""}`}>
      {props.steps.map((step, i) => (
        <li key={i} className={`ui-pipeline__step${step.done ? " ui-pipeline__step--done" : ""}`}>
          <span className="ui-pipeline__check">
            {step.done && <Icon name="check" size={10} />}
          </span>
          <span className="ui-pipeline__body">
            <span className="ui-pipeline__title">{step.title}</span>
            {step.detail && <code className="ui-pipeline__detail">{step.detail}</code>}
          </span>
        </li>
      ))}
    </ol>
  );
}
