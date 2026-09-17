import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';

import type { AppParameter } from './appConfig';

export function ParameterForm({
  parameters,
  values,
  onChange,
  onRun,
  running,
  runnable,
}: {
  parameters: AppParameter[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onRun: () => void;
  running: boolean;
  runnable: boolean;
}) {
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });

  return (
    <form
      className="p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      {

}
      <div className="flex flex-wrap items-start gap-4">
        {parameters.map((parameter) => (
          <div key={parameter.name} className="grid flex-1 basis-56 gap-1.5">
            <Label htmlFor={parameter.name}>{parameter.label === '' ? parameter.name : parameter.label}</Label>
            <ParameterControl
              parameter={parameter}
              value={values[parameter.name] ?? parameter.defaultValue}
              onValueChange={(value) => set(parameter.name, value)}
            />
            {parameter.help === undefined ? null : (
              <p className="text-muted-foreground text-xs">{parameter.help}</p>
            )}
          </div>
        ))}

        <div className="grid gap-1.5">
          {
}
          <Label aria-hidden className="invisible">
            Run
          </Label>
          <Button type="submit" disabled={running || !runnable} className="px-6">
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>

      {
}
      {parameters.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">This app takes no parameters.</p>
      ) : null}
    </form>
  );
}

function ParameterControl({
  parameter,
  value,
  onValueChange,
}: {
  parameter: AppParameter;
  value: string;
  onValueChange: (value: string) => void;
}) {
  if (parameter.type === 'dropdown' && parameter.choices !== undefined) {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={parameter.name} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {parameter.choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      id={parameter.name}

      inputMode={parameter.type === 'number' ? 'decimal' : undefined}
      spellCheck={false}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  );
}
