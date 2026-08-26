import {parseModelRef} from "./catalog.js";

export type OpenLoopCommand = {
  builderModel: {providerID: string; modelID: string};
  reviewerModel: {providerID: string; modelID: string};
  goal: string;
};

export const OPENLOOP_COMMAND_USAGE =
  '/OpenLoop Builder=provider/model & Reviewer=provider/model [Prompt/Goal]';

/** Parse the public /OpenLoop argument format without relying on an LLM. */
export function parseOpenLoopCommand(value: string):
  | {ok: true; command: OpenLoopCommand}
  | {ok: false; error: string} {
  const match = /^\s*Builder\s*=\s*([^&\[]+?)\s*&\s*Reviewer\s*=\s*([^\[]+?)\s*\[([\s\S]+)\]\s*$/i.exec(value);
  if (!match) {
    return {ok: false, error: `expected: ${OPENLOOP_COMMAND_USAGE}`};
  }

  const builderModel = parseModelRef(match[1]!);
  if (!builderModel) {
    return {ok: false, error: 'Builder must be in the form "provider/model"'};
  }
  const reviewerModel = parseModelRef(match[2]!);
  if (!reviewerModel) {
    return {ok: false, error: 'Reviewer must be in the form "provider/model"'};
  }
  const goal = match[3]!.trim();
  if (!goal) return {ok: false, error: "Prompt/Goal cannot be empty"};

  return {ok: true, command: {builderModel, reviewerModel, goal}};
}
