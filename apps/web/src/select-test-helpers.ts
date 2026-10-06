import { act } from 'react';

/** Opens a custom Select and clicks the option with this label, as a user would. */
export async function chooseOption(trigger: Element, label: string) {
  await act(async () => {
    (trigger as HTMLElement).click();
  });
  const anchor = trigger.closest('.ut-popover-anchor')!;
  const options = [...anchor.querySelectorAll<HTMLElement>('[role="option"]')];
  const option = options.find((item) => item.querySelector('.ut-option__label')?.textContent === label);
  if (!option) {
    throw new Error(
      `No select option labelled "${label}"; found ${options.map((item) => item.textContent).join(', ')}`,
    );
  }
  await act(async () => {
    option.click();
  });
}
