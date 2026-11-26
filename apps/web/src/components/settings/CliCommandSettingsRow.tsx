import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useMessages } from "gt-react";
import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { m } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const FAILURE_TITLES = {
  install: msg("Could not install t3"),
  uninstall: msg("Could not remove t3"),
  addToPath: msg("Could not add t3 to PATH"),
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(FAILURE_TITLES[action]),
            description:
              error instanceof Error
                ? (thrownErrorMessage(error, m) ?? error.message)
                : m(msg("Something went wrong.")),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const { state, busy, run } = useDesktopCliCommand();
  const resolve = useMessages();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? resolve(
        msg("路径 {path} 存在其他命令行工具且优先级更高，移除后即可使用 77 Code 的命令。", {
          path: state.shadowedBy,
        }),
      )
    : !installed
      ? resolve(msg("在任意终端通过 `77` 或 `t3` 运行 77 Code 命令行工具。"))
      : state.onPath
        ? resolve(
            msg("已安装在 {path}（同时支持 `77` 与 `t3` 命令）。打开新终端即可使用。", {
              path: state.installedPath,
            }),
          )
        : state.pathSetup?.added
          ? resolve(
              msg("已安装在 {path} 并写入 {file}（同时支持 `77` 与 `t3`）。打开新终端即可使用。", {
                path: state.installedPath,
                file: state.pathSetup.file,
              }),
            )
          : state.pathSetup
            ? resolve(
                msg("已安装在 {path}，但尚未加入 PATH 环境变量。", {
                  path: state.installedPath,
                }),
              )
            : resolve(
                msg("已安装在 {path}，请将其所在目录加入 PATH 以使用 `77` 或 `t3` 命令。", {
                  path: state.installedPath,
                }),
              );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              <T>Add to PATH</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed
              ? resolve(msg("Remove", { $context: "verb, uninstalls the t3 command" }))
              : resolve(msg("Install", { $context: "verb, installs the t3 command" }))}
          </Button>
        </div>
      }
    />
  );
}
