export default function MacrocycleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The global app nav now lives in the (authed) shell (AppNav). This layout
  // just provides the <main> landmark for macrocycle routes.
  return <main>{children}</main>;
}
