// The users table uses an integer (serial) primary key, so session.user.id is
// numeric — see the session callback in auth.ts. We override the whole `user`
// shape (rather than intersecting) so the numeric id does not collide with the
// base `User.id?: string`.
declare module "next-auth" {
  interface Session {
    user: {
      id: number;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

export {};
