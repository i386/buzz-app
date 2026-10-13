// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  CustomModelDialog,
  ModelPicker,
  type ModelChoice,
} from "./ModelPicker";

afterEach(cleanup);

const models: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus", description: "Most capable" },
];

function setup(value = "", props: { allowCustomModel?: boolean } = {}) {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={models}
      allowCustomModel={props.allowCustomModel ?? true}
      value={value}
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  return { onChange, view, user: userEvent.setup() };
}

function setupMenu(value = "", allowCustomModel = true) {
  const onChange = vi.fn();
  function View() {
    const [request, setRequest] = useState<{
      initialValue: string;
      onChange(model: string): void;
    } | null>(null);
    return (
      <>
        <MenuRoot>
          <MenuTrigger render={<Button>Models</Button>} />
          <MenuPopup aria-label="Model choices" size="wide">
            <ModelPicker
              presentation="menu"
              models={models}
              allowCustomModel={allowCustomModel}
              value={value}
              defaultLabel="Default model"
              defaultDescription="Uses the provider default"
              requestCustomModel={(initialValue, commit) =>
                setRequest({ initialValue, onChange: commit })
              }
              onChange={onChange}
            />
          </MenuPopup>
        </MenuRoot>
        {request && (
          <CustomModelDialog
            initialValue={request.initialValue}
            onClose={() => setRequest(null)}
            onSubmit={(model) => {
              request.onChange(model);
              setRequest(null);
            }}
          />
        )}
      </>
    );
  }
  render(<View />);
  return { onChange, user: userEvent.setup() };
}

const control = () => screen.getByRole("combobox", { name: "Model" });

it("shows the default's label when no model is chosen", () => {
  setup("");
  expect(control()).toHaveTextContent("Default model");
});

it("shows the chosen model's label", () => {
  setup("opus");
  expect(control()).toHaveTextContent("Opus");
});

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it.each([
  [true, "Custom model"],
  [false, "Unavailable model"],
])(
  "describes a saved unlisted value when custom entry is %s",
  async (allowCustomModel, description) => {
    const { user } = setup("claude-old-1", { allowCustomModel });
    expect(control()).toHaveTextContent("claude-old-1");
    await user.click(control());
    const option = await screen.findByRole("option", { name: /claude-old-1/ });
    expect(option).toHaveTextContent(description);
    expect(option).toHaveAttribute("aria-selected", "true");
  },
);

it("does not submit a form around the custom-model dialog", async () => {
  const submitted = vi.fn();
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <ModelPicker
        models={models}
        allowCustomModel
        value=""
        defaultLabel="Default model"
        onChange={onChange}
      />
    </form>,
  );
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "claude-custom-1{enter}",
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
  expect(submitted).not.toHaveBeenCalled();
});

it("uses a dropdown to pick listed models when custom entry is disabled", async () => {
  const { onChange, user } = setup("", { allowCustomModel: false });
  expect(control().tagName).toBe("BUTTON");
  expect(control()).toHaveTextContent("Default model");
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("edits a custom model in a dialog without changing the selection on cancel", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  const custom = await screen.findByRole("option", { name: "Custom model" });
  expect(custom).toHaveAccessibleDescription("Enter a model ID");
  await user.click(custom);
  expect(
    await screen.findByRole("dialog", { name: "Custom model" }),
  ).toBeVisible();
  const modelId = screen.getByRole("textbox", { name: "Model ID" });
  await waitFor(() => expect(modelId).toHaveFocus());
  expect(onChange).not.toHaveBeenCalled();
  await user.type(modelId, "ignored-model");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Custom model" })).toBeNull();
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "  claude-custom-1  ",
  );
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
});

it("is disabled as a whole", () => {
  render(
    <ModelPicker
      models={models}
      allowCustomModel
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      disabled
    />,
  );
  expect(control()).toBeDisabled();
});

it("shows that models are loading", () => {
  render(
    <ModelPicker
      models={[]}
      allowCustomModel={false}
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      loading
    />,
  );
  expect(control()).toBeDisabled();
  expect(screen.getByText("Loading models…")).toBeVisible();
});

it("presents rich model rows inside a menu", async () => {
  const { onChange, user } = setupMenu("sonnet");
  await user.click(screen.getByRole("button", { name: "Models" }));
  expect(
    await screen.findByRole("menuitemradio", {
      name: "Default model Uses the provider default",
    }),
  ).not.toBeChecked();
  expect(screen.getByRole("menuitemradio", { name: "Sonnet" })).toBeChecked();
  await user.click(
    screen.getByRole("menuitemradio", { name: "Opus Most capable" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("opens custom model entry from a menu row", async () => {
  const { onChange, user } = setupMenu("sonnet");
  await user.click(screen.getByRole("button", { name: "Models" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: "Custom model Enter a model ID",
    }),
  );
  const modelId = await screen.findByRole("textbox", { name: "Model ID" });
  await user.type(modelId, "claude-future-1");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-future-1");
});
