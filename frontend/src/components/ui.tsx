import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { FlaskConical, X, type LucideIcon } from 'lucide-react';

export function Button({ tone = 'default', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'purple' | 'green' }) {
  return <button type="button" className={`button button-${tone} ${className}`} {...props}>{children}</button>;
}
export function DemoLabel({ children = 'DESIGN DEMO' }: { children?: ReactNode }) {
  return <span className="demo-label"><FlaskConical size={11} aria-hidden="true" />{children}</span>;
}
export function Section({ id, children, className = '' }: { id: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return <motion.section id={id} className={`panel ${className}`} initial={reduce ? false : { opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.04 }} transition={{ duration: 0.35 }}>{children}</motion.section>;
}
export function SectionHeading({ eyebrow, title, icon: Icon, children, green = false }: { eyebrow: string; title: string; icon: LucideIcon; children?: ReactNode; green?: boolean }) {
  return <div className="section-heading"><div><p className={`eyebrow ${green ? 'text-tertiary-fixed-dim' : 'text-primary'}`}><Icon size={14} aria-hidden="true" />{eyebrow}</p><h2>{title}</h2></div>{children}</div>;
}
export function Metric({ label, value, color = 'text-primary' }: { label: string; value: ReactNode; color?: string }) {
  return <div className="metric"><span>{label}</span><strong className={color}>{value}</strong></div>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="flex justify-between items-center gap-4 mb-5"><h2 id="dialog-title">{title}</h2><Button aria-label="Close dialog" onClick={onClose}><X size={18} /></Button></div>
    {children}
  </dialog>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="empty-state">{children}</p>; }
