export const PRESENTATION_STATES = Object.freeze([
    'IDLE', 'COMPACT', 'MINIMAL', 'EXPANDING', 'EXPANDED', 'COLLAPSING',
    'TRANSIENT', 'MEDIA', 'CALL', 'TIMER', 'NOTIFICATION', 'TRANSFER',
    'SYSTEM_EVENT', 'ERROR', 'SUCCESS',
]);

export class TransitionController {
    constructor(initialState = 'IDLE') {
        if (!PRESENTATION_STATES.includes(initialState)) throw new TypeError(`Unknown presentation state: ${initialState}`);
        this.state = initialState;
        this.target = initialState;
        this.revision = 0;
    }

    setState(state) {
        if (!PRESENTATION_STATES.includes(state)) return false;
        this.state = state;
        this.target = state;
        return true;
    }

    retarget(target) {
        if (!PRESENTATION_STATES.includes(target)) throw new TypeError(`Unknown presentation state: ${target}`);
        const token = Object.freeze({revision: ++this.revision, from: this.state, to: target});
        this.target = target;
        this.state = target;
        return token;
    }

    isCurrent(token) {
        return Boolean(token && token.revision === this.revision && token.to === this.target);
    }
}
