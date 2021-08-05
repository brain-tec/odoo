/** @odoo-module **/

import { Listener } from '@mail/model/model_listener';

const { onMounted, onPatched, useComponent } = owl.hooks;

/**
 * This hook provides support for executing code after update (render or patch).
 *
 * @param {Object} param0
 * @param {function} param0.func the function to execute after the update.
 */
export function useUpdate({ func }) {
    const component = useComponent();
    const listener = new Listener({
        onChange: () => component.render(),
    });
    function onUpdate() {
        if (component.env.modelManager) {
            component.env.modelManager.startListening(listener);
        }
        func();
        if (component.env.modelManager) {
            component.env.modelManager.stopListening(listener);
        }
    }
    onMounted(onUpdate);
    onPatched(onUpdate);
    const __destroy = component.__destroy;
    component.__destroy = parent => {
        if (component.env.modelManager) {
            component.env.modelManager.removeListener(listener);
        }
        __destroy.call(component, parent);
    };
}
