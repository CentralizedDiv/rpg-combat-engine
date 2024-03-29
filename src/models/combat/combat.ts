import {
  common_verbose,
  verbose,
  IAction,
  instanceOfEquipmentWithActions,
  Character,
  NPC,
  IEffect,
  EActionType,
  action_creator,
  Player,
  IChildAction,
  instanceOfEffectWithActionPerTurn,
  instanceOfEffectWithActionAfterEnd,
  EEffectType,
  instanceOfEffectWithDamage,
} from "../../internal";
import {
  ICastingEffect,
  IConcentratingEffect,
  instanceOfEffectWithComponents,
} from "../../types/effect.types";
import { ESpellComponent } from "../../types/spell.types";

function shuffleArray(array: Array<any>) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

class ActionNotAvailable extends Error {
  constructor() {
    super("ActionNotAvailable");
  }
}

export type CombatEffects = Array<
  {
    char_id: string;
    remaining_turns: number;
  } & IEffect
>;

export interface TurnState {
  agent: Character;
  available_actions: IAction[];
  allies: Character[];
  enemies: Character[];
  apply_effect: (effect: IEffect, target_id: string) => void;
  remove_effect: (effect_type: EEffectType, target_id: string) => void;
  active_effects: CombatEffects;
}

export interface CombatResult {
  winner: number;
}

export interface ActArguments {
  action: IAction;
  target?: Character;
}

export class Combat {
  private _result: CombatResult;
  private current_index: number;
  private combat_queue: Character[];
  private group_1: Character[];
  private group_2: Character[];
  private verbose: boolean;
  private turn_state: TurnState;
  private active_effects: CombatEffects;

  constructor(
    group_1: Character[],
    group_2: Character[],
    verbose: boolean = true
  ) {
    this.group_1 = group_1;
    this.group_2 = group_2;
    this.verbose = verbose;

    // Initiative
    this.combat_queue = shuffleArray([...group_1, ...group_2]);
    this.current_index = 0;
    this.active_effects = [];
  }

  public init() {
    const combat = this._init();
    let first_round = combat.next();
    return { combat, first_round };
  }

  private *_init(): Generator<TurnState, CombatResult, ActArguments> {
    do {
      const agent = this.combat_queue[this.current_index];
      const { allies, enemies } = this.get_allies_and_enemies(agent);
      this.turn_state = {
        agent,
        available_actions: this.get_available_actions(),
        allies,
        enemies,
        active_effects: this.active_effects,
        apply_effect: this.apply_effect.bind(this),
        remove_effect: this.remove_effect.bind(this),
      };
      let action: IAction, target: Character | undefined;
      if (agent instanceof NPC) {
        ({ action, target } = agent.strategy(this.turn_state));
      } else {
        ({ action, target } = yield this.turn_state);
        if (action.related_skill) {
          (agent as Player).increase_skill(action.related_skill);
        }
      }
      if (action && (action.type === EActionType.NULL || target)) {
        this.act(action, target as Character);
      }
    } while (this._result === undefined);
    return this._result;
  }

  private act(action: IAction, target: Character): CombatResult | undefined {
    if (
      !this.turn_state.available_actions.find(
        (av_action) =>
          av_action.id === action.id ||
          av_action.id === (action as IChildAction).parent_action_id
      )
    ) {
      throw new ActionNotAvailable();
    } else {
      const action_result = action.execute({
        target,
        turn_state: this.turn_state,
      });

      if (this.verbose && typeof action_result === "number") {
        console.log(
          "\n - " +
            this.turn_state.agent.name +
            " " +
            common_verbose["uses"] +
            " " +
            action.name +
            " " +
            common_verbose["on"] +
            " " +
            target.name +
            " " +
            verbose[action.type]?.action_result_label +
            " " +
            action_result.toFixed(2) +
            " " +
            verbose[action.type]?.action_result_unit
        );
      }

      if (
        typeof action_result !== "boolean" ||
        (typeof action_result === "boolean" && action_result === true)
      ) {
        this.move_combat_queue();
      }
    }
    this.check_finish();

    if (this.verbose && this._result?.winner !== undefined) {
      console.log(`\n${this.result}`);
    }
    return this._result;
  }

  private move_combat_queue() {
    let can_attack = false;
    do {
      this.update_active_effects();
      this.current_index = (1 + this.current_index) % this.combat_queue.length;
      if (this.combat_queue[this.current_index].current_hp > 0) {
        can_attack = true;
      }
    } while (!can_attack);
  }

  private update_active_effects() {
    this.active_effects.forEach((effect) => {
      const effect_target = this.get_char_by_id(effect.char_id) as Character;
      const round_start =
        effect.remaining_turns % this.combat_queue.length === 0;
      if (
        instanceOfEffectWithActionPerTurn(effect) &&
        (round_start || effect.remaining_turns === Infinity)
      ) {
        effect.turn_action({
          target: effect_target,
          turn_state: this.turn_state,
        });
      }
      effect.remaining_turns -= 1;
      if (
        instanceOfEffectWithActionAfterEnd(effect) &&
        effect.remaining_turns === 0
      ) {
        effect.action_after_end({ ...this.turn_state, agent: effect_target });
      }
    });
    this.active_effects = this.active_effects.filter(
      (eff) => eff.remaining_turns > 0
    );
  }

  private apply_effect = (effect: IEffect, target_id: string) => {
    const active_effect = this.active_effects.find(
      (eff) => eff.type === effect.type && eff.char_id === target_id
    );
    if (active_effect) {
      if (
        instanceOfEffectWithDamage(active_effect) &&
        instanceOfEffectWithDamage(effect)
      ) {
        const active_effect_dmg = active_effect.damage / active_effect.duration;
        const effect_dmg = effect.damage / effect.duration;
        if (effect_dmg > active_effect_dmg) {
          active_effect.damage = effect.damage;
          active_effect.duration = effect.duration;
          if (
            instanceOfEffectWithActionPerTurn(active_effect) &&
            instanceOfEffectWithActionPerTurn(effect)
          ) {
            active_effect.turn_action = effect.turn_action;
          }
        }
      }
      active_effect.remaining_turns +=
        effect.duration * this.combat_queue.length;
    } else {
      this.active_effects.push({
        char_id: target_id,
        remaining_turns: effect.duration * this.combat_queue.length,
        ...effect,
      });
    }
    this.active_effects.forEach((ae) => {
      if (instanceOfEffectWithComponents(ae)) {
        if (
          (ae.components.includes(ESpellComponent.SOMATIC) &&
            effect.blocks_somatic) ||
          (ae.components.includes(ESpellComponent.VERBAL) &&
            effect.blocks_verbal)
        ) {
          this.remove_effect(effect.type, target_id);
        }
      }
    });
  };

  private remove_effect = (effect_type: EEffectType, char_id: string) => {
    const active_effect_index = this.active_effects.findIndex(
      (eff) => eff.type === effect_type && eff.char_id === char_id
    );
    if (active_effect_index !== -1) {
      this.active_effects = this.active_effects
        .slice(0, active_effect_index)
        .concat(this.active_effects.slice(active_effect_index + 1));
    }
  };

  private check_finish() {
    const sum = (acc: number, curr: Character) => acc + curr.current_hp;
    const sum_group1 = this.group_1.reduce(sum, 0);
    const sum_group2 = this.group_2.reduce(sum, 0);
    if (sum_group1 <= 0) {
      this._result = {
        winner: 1,
      };
    } else if (sum_group2 <= 0) {
      this._result = {
        winner: 0,
      };
    }
  }

  private get_available_actions(): IAction<EActionType>[] {
    const agent = this.combat_queue[this.current_index];
    if (
      this.active_effects.find(
        (eff) => eff.char_id === agent.id && eff.blocks_action === true
      )
    ) {
      return [
        action_creator({
          id: "NULL",
          name: "ZzZz...",
          label: "ZZ",
          description: "Você não consegue agir neste turno",
          execute: () => {
            return true;
          },
          get_available_targets: () => [],
          type: EActionType.NULL,
        }),
      ];
    } else {
      const default_available_actions = agent.default_values.available_actions;
      const available_actions = agent.equipped_equipment
        .reduce((available_actions, equip) => {
          if (instanceOfEquipmentWithActions(equip)) {
            return available_actions.concat(equip.available_actions);
          } else {
            return available_actions;
          }
        }, default_available_actions)
        .concat(...agent.spells);
      return available_actions;
    }
  }

  private get_allies_and_enemies(agent: Character) {
    const is_from_group_1 = this.group_1.find((c) => c.id === agent.id);
    if (is_from_group_1) {
      return { allies: this.group_1, enemies: this.group_2 };
    } else {
      return { allies: this.group_2, enemies: this.group_1 };
    }
  }

  private get_char_by_id(char_id: string) {
    return this.combat_queue.find((char) => char.id === char_id);
  }

  public get result() {
    return `\nO ${
      this._result.winner === 0 ? "primeiro" : "segundo"
    } grupo é o vencedor\n`;
  }
}
