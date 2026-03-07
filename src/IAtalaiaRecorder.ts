export type AtalaiaEventKind = 'movement' | 'person';
export type AtalaiaEventAction = 'pulse' | 'start' | 'stop';

export interface IAtalaiaEvent {
    kind: AtalaiaEventKind;
    action: AtalaiaEventAction;
    smart?: boolean;
    postStopMs?: number;
    maxTotalMs?: number;
}

export interface IAtalaiaRecorder {
    notify(event: IAtalaiaEvent): void;
    notifyMovement(smart?: boolean): void;
    notifyPerson(): void;
    close(): void;
}
