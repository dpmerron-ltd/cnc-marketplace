import { BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ParsedStl } from './types'

export function createStlView(canvas: HTMLCanvasElement, model: ParsedStl) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new Scene()
  scene.background = new Color('#eef1f2')
  scene.add(new HemisphereLight(0xffffff, 0x697780, 2.3))
  const key = new DirectionalLight(0xffffff, 3)
  key.position.set(2, -3, 5); scene.add(key)
  const fill = new DirectionalLight(0xffffff, 1.5)
  fill.position.set(-3, 2, 1); scene.add(fill)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(model.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(model.normals, 3))
  geometry.computeBoundingSphere()
  const radius = Math.max(geometry.boundingSphere!.radius, 0.001)
  const material = new MeshStandardMaterial({ color: '#287f91', roughness: 0.65, metalness: 0.05, side: DoubleSide })
  scene.add(new Mesh(geometry, material))
  const camera = new PerspectiveCamera(35, 1, radius / 1000, radius * 100)
  camera.up.set(0, 0, 1)
  const controls = new OrbitControls(camera, canvas)
  controls.enablePan = false
  controls.minDistance = radius * 1.1
  controls.maxDistance = radius * 12
  const render = () => renderer.render(scene, camera)
  const reset = () => {
    const fov = Math.min(camera.fov * Math.PI / 180, 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect))
    camera.position.copy(new Vector3(1.7, -2.4, 1.8).normalize().multiplyScalar(radius / Math.sin(fov / 2) * 1.12))
    controls.target.set(0, 0, 0); controls.update(); render()
  }
  const resize = () => {
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height; camera.updateProjectionMatrix(); reset()
  }
  controls.addEventListener('change', render)
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()
  return {
    reset,
    async image(): Promise<Blob> {
      render()
      const thumbnail = document.createElement('canvas')
      thumbnail.width = 640; thumbnail.height = 480
      const ctx = thumbnail.getContext('2d')!
      ctx.fillStyle = '#eef1f2'; ctx.fillRect(0, 0, 640, 480)
      const scale = Math.min(640 / canvas.width, 480 / canvas.height)
      const width = canvas.width * scale, height = canvas.height * scale
      ctx.drawImage(canvas, (640 - width) / 2, (480 - height) / 2, width, height)
      return new Promise((resolve, reject) => thumbnail.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not render the STL thumbnail.')), 'image/png'))
    },
    dispose() { observer.disconnect(); controls.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss() },
  }
}
