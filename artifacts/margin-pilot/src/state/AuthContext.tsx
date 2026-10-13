import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseUser
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db, googleProvider, isFirebaseConfigured } from '../lib/firebase';
import { STORAGE_KEY } from '../i18n/config';

export interface User {
  id: string;
  email: string;
  name: string;
  storeName?: string;
  avatarUrl?: string;
  storeId?: string;
  preferredLanguage?: string;
}

interface AuthContextType {
  user: User | null;
  firebaseUser: FirebaseUser | null;
  isLoading: boolean;
  login: (email: string, password?: string) => Promise<{ success: boolean; error?: string }>;
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  loginAsDemo: (demoEmail?: string, demoName?: string, store?: string) => { success: boolean };
  register: (name: string, email: string, password?: string, storeName?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  updatePreferredLanguage: (langCode: string) => Promise<void>;
  requestedRoute: string | null;
  setRequestedRoute: (route: string | null) => void;
  authModalOpen: boolean;
  authModalTab: 'signin' | 'register';
  openAuthModal: (tab?: 'signin' | 'register', returnTo?: string) => void;
  closeAuthModal: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const AUTH_USER_KEY = 'arthiva-auth-user';
const REQUESTED_ROUTE_KEY = 'arthiva-requested-route';

async function syncUserProfile(fbUser: FirebaseUser, storeNameHint?: string): Promise<User> {
  const currentSavedLang = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'en';
    } catch {
      return 'en';
    }
  })();

  const fallbackUser: User = {
    id: fbUser.uid,
    email: fbUser.email || '',
    name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Operations Pilot',
    storeName: storeNameHint?.trim() || `${(fbUser.displayName || 'Operations').split(' ')[0]}'s Store`,
    avatarUrl: fbUser.photoURL || undefined,
    storeId: `store_${fbUser.uid.slice(0, 8)}`,
    preferredLanguage: currentSavedLang,
  };

  if (!isFirebaseConfigured) {
    return fallbackUser;
  }

  try {
    const userRef = doc(db, 'users', fbUser.uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      const data = snap.data();
      const resolvedLang = data.preferredLanguage || currentSavedLang;
      return {
        id: fbUser.uid,
        email: fbUser.email || '',
        name: data.displayName || fbUser.displayName || 'Operations Pilot',
        storeName: data.storeName || 'Arthiva Store',
        avatarUrl: fbUser.photoURL || undefined,
        storeId: `store_${fbUser.uid.slice(0, 8)}`,
        preferredLanguage: resolvedLang,
      };
    } else {
      const displayName = fbUser.displayName || fbUser.email?.split('@')[0] || 'Operations Pilot';
      const storeName = storeNameHint?.trim() || `${displayName.split(' ')[0]}'s Store`;
      const initialProfile = {
        userId: fbUser.uid,
        email: fbUser.email || '',
        displayName,
        storeName,
        preferredLanguage: currentSavedLang,
        photoURL: fbUser.photoURL || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await setDoc(userRef, initialProfile, { merge: true });
      return {
        id: fbUser.uid,
        email: fbUser.email || '',
        name: initialProfile.displayName,
        storeName: initialProfile.storeName,
        avatarUrl: fbUser.photoURL || undefined,
        storeId: `store_${fbUser.uid.slice(0, 8)}`,
        preferredLanguage: currentSavedLang,
      };
    }
  } catch (err) {
    console.warn('[Firebase] Firestore user profile sync notice (using auth profile):', err);
    return fallbackUser;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const stored = localStorage.getItem(AUTH_USER_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'signin' | 'register'>('signin');
  const [requestedRoute, setRequestedRouteState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(REQUESTED_ROUTE_KEY);
    } catch {
      return null;
    }
  });

  const setRequestedRoute = (route: string | null) => {
    setRequestedRouteState(route);
    if (route) {
      sessionStorage.setItem(REQUESTED_ROUTE_KEY, route);
    } else {
      sessionStorage.removeItem(REQUESTED_ROUTE_KEY);
    }
  };

  const openAuthModal = (tab: 'signin' | 'register' = 'signin', returnTo?: string) => {
    if (returnTo) {
      setRequestedRoute(returnTo);
    }
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  };

  const closeAuthModal = () => {
    setAuthModalOpen(false);
  };

  // Listen to Firebase Auth state
  useEffect(() => {
    try {
      const unsubscribe = onAuthStateChanged(
        auth,
        async (fbUser) => {
          setFirebaseUser(fbUser);
          if (fbUser) {
            const appUser = await syncUserProfile(fbUser);
            setUser(appUser);
            try {
              localStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
            } catch {
              // ignore
            }
          } else {
            setUser(null);
            localStorage.removeItem(AUTH_USER_KEY);
          }
          setIsLoading(false);
        },
        (error: any) => {
          console.error('[Firebase Auth] Auth listener error:', error?.message || error);
          setIsLoading(false);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      console.error('[Firebase Auth] Subscription error:', err);
      setIsLoading(false);
    }
  }, []);

  const loginWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);

    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const appUser = await syncUserProfile(cred.user);
      setUser(appUser);
      setFirebaseUser(cred.user);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
      setIsLoading(false);
      setAuthModalOpen(false);
      return { success: true };
    } catch (err: any) {
      console.error('[Firebase Auth] Google sign-in error:', err?.code, err?.message);
      setIsLoading(false);
      const friendlyMessage =
        err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request'
          ? 'Sign-in popup was closed before completing. Please try again.'
          : err?.code === 'auth/popup-blocked'
          ? 'Popup window was blocked by your browser. Please allow popups.'
          : err?.message || 'Firebase Authentication failed.';
      return { success: false, error: friendlyMessage };
    }
  };

  const login = async (email: string, password = ''): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    const cleanEmail = email.trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setIsLoading(false);
      return { success: false, error: 'Please enter a valid email address' };
    }
    if (!password) {
      setIsLoading(false);
      return { success: false, error: 'Please enter your password' };
    }

    try {
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
      const appUser = await syncUserProfile(cred.user);
      setUser(appUser);
      setFirebaseUser(cred.user);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
      setIsLoading(false);
      setAuthModalOpen(false);
      return { success: true };
    } catch (err: any) {
      console.error('[Firebase Auth] Email login error:', err?.code, err?.message);
      setIsLoading(false);
      let errorMsg = 'Failed to sign in with Firebase Auth.';
      if (
        err?.code === 'auth/invalid-credential' ||
        err?.code === 'auth/wrong-password' ||
        err?.code === 'auth/user-not-found'
      ) {
        errorMsg = 'Invalid email or password. If you do not have an account, please register first.';
      } else if (err?.code === 'auth/operation-not-allowed') {
        errorMsg = 'Email/Password sign-in is not enabled in Firebase Console. Please use "Continue with Google".';
      } else if (err?.message) {
        errorMsg = err.message;
      }
      return { success: false, error: errorMsg };
    }
  };

  const register = async (name: string, email: string, password = '', storeName?: string): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    const cleanEmail = email.trim();
    const cleanName = name.trim() || cleanEmail.split('@')[0];
    const cleanStore = storeName?.trim() || `${cleanName.split(' ')[0]}'s Store`;

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setIsLoading(false);
      return { success: false, error: 'Please enter a valid email address' };
    }
    if (!password || password.length < 6) {
      setIsLoading(false);
      return { success: false, error: 'Password must be at least 6 characters' };
    }

    try {
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      if (cleanName) {
        await updateProfile(cred.user, { displayName: cleanName }).catch(() => {});
      }
      const appUser = await syncUserProfile(cred.user, cleanStore);
      setUser(appUser);
      setFirebaseUser(cred.user);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
      setIsLoading(false);
      setAuthModalOpen(false);
      return { success: true };
    } catch (err: any) {
      console.error('[Firebase Auth] Registration error:', err?.code, err?.message);
      setIsLoading(false);
      let errorMsg = 'Failed to register with Firebase Auth.';
      if (err?.code === 'auth/email-already-in-use') {
        errorMsg = 'This email is already registered. Please sign in instead.';
      } else if (err?.code === 'auth/weak-password') {
        errorMsg = 'Password is too weak. Please use at least 6 characters.';
      } else if (err?.code === 'auth/operation-not-allowed') {
        errorMsg = 'Email/Password registration is not enabled in Firebase Console. Please use "Continue with Google".';
      } else if (err?.message) {
        errorMsg = err.message;
      }
      return { success: false, error: errorMsg };
    }
  };

  const loginAsDemo = (demoEmail = 'operations@ojasbotanics.in', demoName = 'Priya Sharma', store = 'Ojas Botanics') => {
    const appUser: User = {
      id: 'usr_demo_pilot',
      email: demoEmail,
      name: demoName,
      storeName: store,
      storeId: 'store_ojas_demo',
    };
    setUser(appUser);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(appUser));
    setIsLoading(false);
    setAuthModalOpen(false);
    return { success: true };
  };

  const logout = async () => {
    if (isFirebaseConfigured) {
      try {
        await signOut(auth);
      } catch (err) {
        console.warn('Firebase signOut notice:', err);
      }
    }
    setUser(null);
    setFirebaseUser(null);
    localStorage.removeItem(AUTH_USER_KEY);
    sessionStorage.removeItem(REQUESTED_ROUTE_KEY);
  };

  const updatePreferredLanguage = async (langCode: string) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, preferredLanguage: langCode };
      try {
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });

    try {
      localStorage.setItem(STORAGE_KEY, langCode);
    } catch {
      // ignore
    }

    if (user?.id && isFirebaseConfigured) {
      try {
        const userRef = doc(db, 'users', user.id);
        await setDoc(
          userRef,
          {
            userId: user.id,
            preferredLanguage: langCode,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (err) {
        console.warn('[Firebase] Could not persist preferredLanguage:', err);
      }
    }
  };

  const value = useMemo(() => ({
    user,
    firebaseUser,
    isLoading,
    login,
    loginWithGoogle,
    loginAsDemo,
    register,
    logout,
    updatePreferredLanguage,
    requestedRoute,
    setRequestedRoute,
    authModalOpen,
    authModalTab,
    openAuthModal,
    closeAuthModal,
  }), [user, firebaseUser, isLoading, requestedRoute, authModalOpen, authModalTab]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
