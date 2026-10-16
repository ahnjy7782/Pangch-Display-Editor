import { Matrix4, Vector3 } from 'three/webgpu';

export const maxShearAngle = 85 * Math.PI / 180;

export function getShearDragDelta(
    pivot: Vector3,
    rotationAxis: Vector3,
    pointStart: Vector3,
    angle: number,
    out = new Matrix4()
): Matrix4 {
    out.identity();
    if (!Number.isFinite(angle)) return out;
    const axis = rotationAxis.clone().normalize();
    const radial = pointStart.clone().addScaledVector(axis, -pointStart.dot(axis)).normalize();
    if (axis.lengthSq() === 0 || radial.lengthSq() === 0) return out;
    const tangent = new Vector3().crossVectors(axis, radial);
    // Keep tan(angle) finite as the dragged face approaches a right angle.
    const amount = Math.tan(Math.max(-maxShearAngle, Math.min(maxShearAngle, angle)));
    const e = out.elements;
    for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
            e[column * 4 + row] += amount * tangent.getComponent(row) * radial.getComponent(column);
        }
    }
    return out.setPosition(pivot.clone().sub(pivot.clone().applyMatrix4(out)));
}
