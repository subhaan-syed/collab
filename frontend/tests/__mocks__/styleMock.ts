// Mock for CSS/SCSS modules in Jest
const styleMock = new Proxy({}, { get: (_target, prop) => String(prop) });
export default styleMock;
